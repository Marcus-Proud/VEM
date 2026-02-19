# Reachmee → Webflow Sync

Automatisk synkronisering av jobbannonser från Reachmee till Webflow CMS.

## Vad den gör

- ➕ Skapar nya jobb som dyker upp i Reachmee-flödet
- ✏️ Uppdaterar befintliga jobb om något ändrats
- 🗄️ Arkiverar jobb som försvunnit från flödet
- 🚀 Publicerar alla ändringar automatiskt
- Kör automatiskt varje timme via GitHub Actions

## Setup

### 1. Skapa ett GitHub-repo

Ladda upp filerna `sync.js` och `.github/workflows/sync.yml` till ett nytt repo.

### 2. Hämta din Webflow API-token

1. Gå till **Webflow → Account Settings → API Access**
2. Skapa en ny token med tillgång till **CMS**
3. Kopiera token-värdet

### 3. Lägg till token som GitHub Secret

1. Gå till ditt GitHub-repo → **Settings → Secrets and variables → Actions**
2. Klicka **New repository secret**
3. Namn: `WEBFLOW_API_TOKEN`
4. Värde: din Webflow API-token

### 4. Aktivera GitHub Actions

GitHub Actions aktiveras automatiskt när du pushar `.github/workflows/sync.yml`.
Du kan också köra synken manuellt via **Actions → Reachmee → Webflow Sync → Run workflow**.

## Fältmappning

| Reachmee | Webflow |
|---|---|
| `ad_id` | `position-id-v2` (synk-nyckel) |
| `title` | `name` |
| `description` | `beskrivning-2` |
| `link` | `lank-till-reachmee` |
| `organizations[0].nameorgunit` | `company` |
| `areas[0].name` | `omrade` |
| `occupation_area` | `kategori` |
| `publishing_date` | `datum` |
| `contact_persons[0]` | `kontaktperson-v3`, `kontaktperson-e-post`, `kontaktperson-telefon` |
| `contact_persons[1]` | `kontaktperson-2-namn`, `kontaktperson-2-e-post`, `kontaktperson-2-telefon` |

## Ändra intervall

Redigera cron-uttrycket i `.github/workflows/sync.yml`:

```yaml
- cron: "0 * * * *"   # Varje timme
- cron: "*/30 * * * *" # Var 30:e minut
- cron: "0 8,12,16 * * *" # 08:00, 12:00, 16:00 varje dag
```
