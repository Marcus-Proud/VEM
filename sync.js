/**
 * Reachmee → Webflow CMS Sync
 *
 * Synkar jobbannonser från Reachmee JSON-flöde till Webflow CMS.
 * - Skapar nya jobb som inte finns i Webflow
 * - Uppdaterar befintliga jobb om något ändrats
 * - Arkiverar jobb som försvunnit från flödet
 * - Publicerar alla ändringar automatiskt
 * - Matchar kontaktpersoner mot Medarbetare-collectionen via e-post
 * - Sätter "AD updated" till dagens datum när en förändring upptäcks
 * - Ingress uppdateras aldrig vid uppdateringar, bara vid skapande
 */

const REACHMEE_FEED_URL =
  "https://site201.reachmee.com/api/public/v1/feed/6?lang=SE&customer=vem&format=json&feed_key=psf7junkfp";

const WEBFLOW_API_TOKEN = process.env.WEBFLOW_API_TOKEN;
const WEBFLOW_COLLECTION_ID = "698efc0f2ce6e1819bf28c85";
const WEBFLOW_STAFF_COLLECTION_ID = "698efc0f2ce6e1819bf28cc7";
const WEBFLOW_API_BASE = "https://api.webflow.com/v2";

// Fält som jämförs för att avgöra om ett jobb ska uppdateras
// Ingress ingår inte här eftersom den aldrig ska uppdateras
const FIELDS_TO_COMPARE = [
  "name",
  "beskrivning-2",
  "company",
  "omrade",
  "kategori",
  "lank-till-reachmee",
  "kontaktperson-vem",
  "kontaktperson-vem-2",
  "kontaktperson-v3",
  "kontaktperson-e-post",
  "kontaktperson-telefon",
  "kontaktperson-2-namn",
  "kontaktperson-2-e-post",
  "kontaktperson-2-telefon",
];

// ─── Hjälpfunktioner ─────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateSlug(job) {
  return `${job.project_id}-${job.ad_id}`;
}

function formatContactName(person) {
  if (!person) return null;
  return `${person.first_name || ""} ${person.surname || ""}`.trim() || null;
}

/**
 * Extraherar första meningen från HTML-beskrivningen och returnerar som ren text.
 * Fältet är "single line" i Webflow så radbrytningar måste rensas bort.
 */
function extractIngress(html) {
  if (!html) return null;

  const plainText = html
    .replace(/<[^>]+>/g, " ")   // Ta bort HTML-taggar
    .replace(/&nbsp;/g, " ")    // Ersätt &nbsp;
    .replace(/&[a-z]+;/g, "")   // Ta bort övriga HTML-entiteter
    .replace(/[\r\n\t]+/g, " ") // Ta bort radbrytningar och tabbar
    .replace(/  +/g, " ")       // Ersätt flera mellanslag med ett
    .trim();

  // Plocka ut första meningen (avslutad med . ! eller ?)
  const match = plainText.match(/^.+?[.!?]/);
  if (match) return match[0].trim();

  // Om ingen punkt hittas, returnera de första 150 tecknen
  return plainText.substring(0, 150).trim() || null;
}

/**
 * Bygger bas-fieldData från ett Reachmee-jobb (utan ingress).
 * Används både vid skapande och uppdatering.
 */
function buildFieldData(job, staffByEmail) {
  const contact1 = job.contact_persons?.[0] || null;
  const contact2 = job.contact_persons?.[1] || null;
  const org = job.organizations?.[0]?.nameorgunit || null;
  const area = job.areas?.[0]?.name || null;

  // Slå upp Webflow-ID för kontaktpersoner via e-post
  const staffId1 = contact1?.email
    ? staffByEmail.get(contact1.email.toLowerCase()) ?? null
    : null;
  const staffId2 = contact2?.email
    ? staffByEmail.get(contact2.email.toLowerCase()) ?? null
    : null;

  if (contact1?.email && !staffId1) {
    console.log(`  ⚠️  Ingen medarbetare hittad för e-post: ${contact1.email}`);
  }
  if (contact2?.email && !staffId2) {
    console.log(`  ⚠️  Ingen medarbetare hittad för e-post: ${contact2.email}`);
  }

  return {
    name: job.title,
    "position-id-v2": job.ad_id,
    "beskrivning-2": job.description || null,
    company: org,
    omrade: area,
    kategori: job.occupation_area !== "[Annat...]" ? job.occupation_area : null,
    "lank-till-reachmee": job.link || null,
    datum: job.publishing_date
      ? new Date(job.publishing_date).toISOString()
      : null,
    // Relaterade fält (Webflow item-ID från Medarbetare-collectionen)
    "kontaktperson-vem": staffId1,
    "kontaktperson-vem-2": staffId2,
    // Fritext-fält som fallback om medarbetaren inte finns i Webflow
    "kontaktperson-v3": formatContactName(contact1),
    "kontaktperson-e-post": contact1?.email || null,
    "kontaktperson-telefon": contact1?.phone || null,
    "kontaktperson-2-namn": formatContactName(contact2),
    "kontaktperson-2-e-post": contact2?.email || null,
    "kontaktperson-2-telefon": contact2?.phone || null,
  };
}

/**
 * Jämför om ett jobb behöver uppdateras
 */
function hasChanges(newData, existingFieldData) {
  for (const field of FIELDS_TO_COMPARE) {
    const newVal = newData[field] ?? null;
    const oldVal = existingFieldData[field] ?? null;
    if (newVal !== oldVal) {
      console.log(`  Ändring i fält "${field}": "${oldVal}" → "${newVal}"`);
      return true;
    }
  }
  return false;
}

// ─── Webflow API ──────────────────────────────────────────────────────────────

async function webflowRequest(method, path, body = null) {
  const url = `${WEBFLOW_API_BASE}${path}`;
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${WEBFLOW_API_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);

  // Hantera rate limiting
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") || "10") * 1000;
    console.log(`  Rate limit nådd, väntar ${retryAfter / 1000}s...`);
    await sleep(retryAfter);
    return webflowRequest(method, path, body);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Webflow API fel ${res.status} på ${path}: ${text}`);
  }

  return res.json();
}

/**
 * Hämtar ALLA items från en given collection (paginerat)
 */
async function getAllItems(collectionId) {
  const items = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const data = await webflowRequest(
      "GET",
      `/collections/${collectionId}/items?limit=${limit}&offset=${offset}`
    );
    items.push(...data.items);
    if (items.length >= data.pagination.total) break;
    offset += limit;
    await sleep(200);
  }

  return items;
}

async function createItem(fieldData) {
  return webflowRequest(
    "POST",
    `/collections/${WEBFLOW_COLLECTION_ID}/items`,
    { fieldData, isDraft: false }
  );
}

async function updateItem(itemId, fieldData) {
  return webflowRequest(
    "PATCH",
    `/collections/${WEBFLOW_COLLECTION_ID}/items/${itemId}`,
    { fieldData }
  );
}

async function publishItems(itemIds) {
  if (itemIds.length === 0) return;
  return webflowRequest(
    "POST",
    `/collections/${WEBFLOW_COLLECTION_ID}/items/publish`,
    { itemIds }
  );
}

async function archiveItem(itemId) {
  return webflowRequest(
    "PATCH",
    `/collections/${WEBFLOW_COLLECTION_ID}/items/${itemId}`,
    { fieldData: {}, isArchived: true }
  );
}

// ─── Reachmee ─────────────────────────────────────────────────────────────────

async function fetchReachmeeFeed() {
  const res = await fetch(REACHMEE_FEED_URL, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Reachmee fetch misslyckades: ${res.status}`);
  return res.json();
}

// ─── Huvudlogik ───────────────────────────────────────────────────────────────

async function sync() {
  if (!WEBFLOW_API_TOKEN) {
    throw new Error("WEBFLOW_API_TOKEN saknas i miljövariablerna");
  }

  console.log("🔄 Startar synk...\n");

  // 1. Hämta data från Reachmee
  console.log("📥 Hämtar Reachmee-flöde...");
  const reachmeeJobs = await fetchReachmeeFeed();
  console.log(`   ${reachmeeJobs.length} jobb hittade i Reachmee\n`);

  // 2. Hämta befintliga jobb från Webflow
  console.log("📥 Hämtar befintliga Webflow-items...");
  const webflowItems = await getAllItems(WEBFLOW_COLLECTION_ID);
  console.log(`   ${webflowItems.length} items hittade i Webflow\n`);

  // 3. Hämta medarbetare och bygg e-post → Webflow item-ID map
  console.log("📥 Hämtar medarbetare från Webflow...");
  const staffItems = await getAllItems(WEBFLOW_STAFF_COLLECTION_ID);
  const staffByEmail = new Map();
  for (const staff of staffItems) {
    const email = staff.fieldData["e-post"];
    if (email) staffByEmail.set(email.toLowerCase(), staff.id);
  }
  console.log(
    `   ${staffItems.length} medarbetare hittade (${staffByEmail.size} med e-post)\n`
  );

  // 4. Bygg lookup-map: ad_id → webflow item
  const webflowByAdId = new Map();
  for (const item of webflowItems) {
    const adId = item.fieldData["position-id-v2"];
    if (adId) webflowByAdId.set(adId, item);
  }

  // 5. Bygg set med alla ad_id:n från Reachmee (för att hitta borttagna)
  const reachmeeAdIds = new Set(reachmeeJobs.map((j) => j.ad_id));

  const toPublish = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let archived = 0;

  const now = new Date().toISOString();

  // 6. Loopa igenom Reachmee-jobben
  for (const job of reachmeeJobs) {
    const fieldData = buildFieldData(job, staffByEmail);
    const existing = webflowByAdId.get(job.ad_id);

    if (!existing) {
      // Nytt jobb – lägg till ingress och skapa
      console.log(`➕ Skapar: "${job.title}" (ad_id: ${job.ad_id})`);
      fieldData.slug = generateSlug(job);
      fieldData.ingress = extractIngress(job.description);
      const createdItem = await createItem(fieldData);
      toPublish.push(createdItem.id);
      created++;
    } else {
      // Befintligt jobb – kolla om det ändrats
      // Ingress ingår inte i jämförelsen och skickas inte med vid uppdatering
      if (hasChanges(fieldData, existing.fieldData)) {
        console.log(`✏️  Uppdaterar: "${job.title}" (ad_id: ${job.ad_id})`);
        fieldData["ad-updated"] = now;
        await updateItem(existing.id, fieldData);
        toPublish.push(existing.id);
        updated++;
      } else {
        console.log(`✓  Oförändrat: "${job.title}" (ad_id: ${job.ad_id})`);
        unchanged++;
      }
    }

    await sleep(200); // Undvik rate limiting
  }

  // 7. Arkivera jobb som försvunnit från Reachmee
  for (const item of webflowItems) {
    const adId = item.fieldData["position-id-v2"];
    if (adId && !reachmeeAdIds.has(adId) && !item.isArchived) {
      console.log(`🗄️  Arkiverar: "${item.fieldData.name}" (ad_id: ${adId})`);
      await archiveItem(item.id);
      archived++;
      await sleep(200);
    }
  }

  // 8. Publicera alla nya/uppdaterade items
  if (toPublish.length > 0) {
    console.log(`\n🚀 Publicerar ${toPublish.length} items...`);
    for (let i = 0; i < toPublish.length; i += 100) {
      await publishItems(toPublish.slice(i, i + 100));
      await sleep(500);
    }
  }

  // 9. Sammanfattning
  console.log("\n✅ Synk klar!");
  console.log(`   Skapade:     ${created}`);
  console.log(`   Uppdaterade: ${updated}`);
  console.log(`   Oförändrade: ${unchanged}`);
  console.log(`   Arkiverade:  ${archived}`);
}

sync().catch((err) => {
  console.error("❌ Synk misslyckades:", err.message);
  process.exit(1);
});
