# SiCepat Bulk Phone Rechecker

A local web app to process bulk SiCepat shipment Excel files and retrieve unmasked
recipient phone numbers from the SiCepat POD API.

## Stack

- **Frontend:** Vue 3, TypeScript, Vite, Tailwind CSS, Lucide Icons, Axios, SheetJS
- **Backend:** Node.js, Express, Axios (a local proxy to avoid browser CORS)

## Requirements

- Node.js 14.18+ (tested with 14.20). Node 16/18/20/22 also work.

## Install & run

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

- `npm run dev` starts the Vite dev server (port 5173) and the Express proxy (port 3001).
- Production-style local usage: `npm run build` then `npm start`, and open http://localhost:3001.
- Environment variables (set before starting the proxy): `SICEPAT_BASE_URL` (default `https://podapi.sicepat.com/`) and `PORT` (default `3001`).

## Usage

1. Open **Settings**, enter your **Bearer Token**, **X-Permission-Token**, and **User ID**, then **Save Changes**.
2. Return to the **Dashboard** and upload a SiCepat Excel file (columns `Resi`, `Penerima`, `No HP Penerima`, `Kota_Tujuan`, `NAMA YANG MENGERJAKAN`).
3. Click **Start Processing**.
4. Monitor progress and results, then **Download Excel** to get a new `*-rechecked.xlsx` file.

## Behavior notes

- AWB numbers are treated as strings (leading zeros preserved).
- Requests are sent one at a time by default, with a configurable delay, retry/backoff, and
  pause / resume / stop controls.
- 401/403 stop the run with a notice; 429/5xx/network errors are retried.
- Duplicate or empty AWBs are skipped; failed records keep their original phone numbers.
- The original uploaded file is never overwritten — results are written to a new file.
- Credentials are stored in `localStorage`, never logged, and only sent to the SiCepat API
  through the local proxy.
