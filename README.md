# Mizu Coin API Gateway & Explorer

API server + Developer Portal untuk **Mizu Coin (MZU)**.

## Fitur

- **Developer Portal** — Register / Login, dapat **API Key + Secret Token unik** per akun
- **Wallet API** — Generate wallet, cek saldo, riwayat transaksi
- **Cloud Mining Integration** — Start / Stop / Claim / Status  
  Rate: **1 MZU per 2 hari** (bisa diklaim per menit, stop tetap dapat yang sudah terkumpul)
- **Transfer Cepat** — Single & Batch transfer
- **Explorer** — Cari TX / Address, Stats, Top Wallets
- **Live Feed** — Real-time transaksi via Server-Sent Events
- **Total Supply** 500.000.000 MZU (tracking total mined)
- Data disimpan di `data.json` (persistent antar restart)

> Catatan: Ini **bukan blockchain sungguhan**. Ini API gateway simulasi + ledger in-memory/file untuk integrasi aplikasi lain. Mining hanya integrasi (bukan real PoW/PoS).

## Cara Menjalankan Lokal

```bash
# 1. Install dependency
npm install

# 2. Jalankan server
npm start
# atau development (auto-reload)
npm run dev
```

Buka browser: **http://localhost:3000**

## Deploy / Hosting (Server Blockchain Sendiri)

Karena ini Node.js Express, kamu bisa upload ke:

| Platform | Gratis? | Cocok untuk | Catatan |
|----------|---------|-------------|---------|
| **Render.com** | Ya (free tier) | Paling mudah | Web Service, auto deploy dari GitHub |
| **Railway.app** | Ya (credit) | Mudah | Connect GitHub |
| **Fly.io** | Ya | Global | CLI deploy |
| **DigitalOcean App Platform** | Ada free trial | Stabil | |
| **VPS** (Contabo, Vultr, DigitalOcean Droplet) | Bayar | Full kontrol | Install Node.js sendiri |
| **Oracle Cloud Free Tier** | Ya | Permanen free | Butuh setup manual |

### Langkah cepat di Render.com (rekomendasi)

1. Push folder ini ke GitHub (repo baru)
2. Buka [render.com](https://render.com) → New → Web Service
3. Connect repo GitHub kamu
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Deploy → dapat URL seperti `https://mizu-coin-api.onrender.com`

Frontend & backend sudah digabung, jadi cukup 1 URL.

### Jangan pakai GitHub Pages saja

GitHub Pages hanya static HTML. API (Node.js) **tidak bisa** jalan di situ. Makanya login gagal sebelumnya.

## Endpoint Utama

### Developer
- `POST /api/developer/register` → `{ username, password }`
- `POST /api/developer/login` → `{ username, password }`
- `GET  /api/developer/me` (header: `x-api-key`)

### Wallet & Mining (semua butuh header `x-api-key`)
- `POST /api/v1/wallet/create`
- `GET  /api/v1/wallet/balance?address=...`
- `GET  /api/v1/wallet/info?address=...`
- `GET  /api/v1/wallet/transactions?address=...`
- `POST /api/v1/mining/start` → `{ address }`
- `POST /api/v1/mining/stop` → `{ address }`
- `POST /api/v1/mining/claim` → `{ address }`
- `GET  /api/v1/mining/status?address=...`
- `POST /api/v1/transfer` → `{ fromAddress, toAddress, amount }`
- `POST /api/v1/transfer/batch`

### Explorer (publik)
- `GET /api/explorer/search?query=...`
- `GET /api/explorer/stats`
- `GET /api/explorer/transactions/latest`
- `GET /api/explorer/top-wallets`
- `GET /api/explorer/feed` (SSE)

## Contoh Integrasi di Aplikasi Lain

```javascript
const API = 'https://your-server.onrender.com';
const API_KEY = 'mizu_pk_xxxxx';

// Buat wallet
const res = await fetch(`${API}/api/v1/wallet/create`, {
  method: 'POST',
  headers: { 'x-api-key': API_KEY }
});
const { address } = await res.json();

// Start mining
await fetch(`${API}/api/v1/mining/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
  body: JSON.stringify({ address })
});

// Claim
await fetch(`${API}/api/v1/mining/claim`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
  body: JSON.stringify({ address })
});
```

## Struktur File

```
mizu-coin-api/
├── package.json
├── server.js          # Backend API lengkap
├── index.html         # Frontend Developer Portal + Explorer
├── data.json          # Auto-generated (data persistent)
└── README.md
```

## License

MIT
