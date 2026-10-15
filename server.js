const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// ===================== KONFIGURASI MIZU COIN =====================
const TOTAL_SUPPLY = 500_000_000;           // 500 juta MZU
const RATE_PER_SECOND = 1 / (2 * 86400);    // 1 MZU per 2 hari ≈ 0.000005787 per detik
const MAX_ACCRUAL_SECONDS = 2 * 86400;      // Max akumulasi 2 hari
// ================================================================

app.use(cors());
app.use(bodyParser.json());

// Serve frontend statis (index.html) dari folder yang sama
app.use(express.static(__dirname));

// --- DATABASE (file-based supaya data tidak hilang saat restart) ---
let developers = {}; // { apiKey: { username, passwordHash, token, createdAt } }
let wallets = {};    // { address: { balance, miningStatus, lastMinedTimestamp, developerApiKey } }
let globalTransactions = [];
let totalMined = 0;  // Tracking supply yang sudah di-mining
let clients = [];

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const data = JSON.parse(raw);
      developers = data.developers || {};
      wallets = data.wallets || {};
      globalTransactions = data.globalTransactions || [];
      totalMined = data.totalMined || 0;
      console.log('Data berhasil dimuat dari data.json');
    }
  } catch (e) {
    console.error('Gagal load data:', e.message);
  }
}

function saveData() {
  try {
    const data = { developers, wallets, globalTransactions, totalMined };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Gagal save data:', e.message);
  }
}

loadData();
// Auto-save setiap 30 detik
setInterval(saveData, 30000);

// Helper
function generateDeveloperCredentials() {
  const apiKey = 'mizu_pk_' + crypto.randomBytes(16).toString('hex');
  const token = 'mizu_sk_' + crypto.randomBytes(32).toString('hex');
  return { apiKey, token };
}

function generateHash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function broadcastToClients(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(client => {
    try { client.write(payload); } catch (_) {}
  });
}

// ==========================================
// 1. DEVELOPER AUTH (Register / Login)
// ==========================================

app.post('/api/developer/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi' });
  }
  if (username.length < 3) {
    return res.status(400).json({ error: 'Username minimal 3 karakter' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'Password minimal 4 karakter' });
  }

  const existing = Object.values(developers).find(d => d.username === username);
  if (existing) {
    return res.status(400).json({ error: 'Username sudah terdaftar' });
  }

  const { apiKey, token } = generateDeveloperCredentials();
  developers[apiKey] = {
    username,
    passwordHash: generateHash(password),
    token,
    createdAt: new Date().toISOString()
  };
  saveData();

  res.json({
    message: 'Registrasi Developer Berhasil',
    apiKey,
    token,
    note: 'Simpan API Key & Token dengan aman. Setiap akun punya key unik.'
  });
});

app.post('/api/developer/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi' });
  }

  const apiKey = Object.keys(developers).find(
    key => developers[key].username === username &&
           developers[key].passwordHash === generateHash(password)
  );

  if (!apiKey) {
    return res.status(401).json({ error: 'Login gagal. Username atau password salah.' });
  }

  res.json({
    message: 'Login sukses',
    apiKey,
    token: developers[apiKey].token,
    username
  });
});

// Info developer (opsional)
app.get('/api/developer/me', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || !developers[apiKey]) {
    return res.status(403).json({ error: 'API Key tidak valid' });
  }
  const dev = developers[apiKey];
  res.json({
    username: dev.username,
    apiKey,
    token: dev.token,
    createdAt: dev.createdAt
  });
});

// Middleware Autentikasi
function authenticateAPI(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || !developers[apiKey]) {
    return res.status(403).json({ error: 'API Key tidak valid atau tidak ditemukan' });
  }
  req.developer = developers[apiKey];
  req.apiKey = apiKey;
  next();
}

// ==========================================
// 2. WALLET, MINING, TRANSFER
// ==========================================

// Buat wallet baru (unik per developer)
app.post('/api/v1/wallet/create', authenticateAPI, (req, res) => {
  const address = 'mizu' + crypto.randomBytes(20).toString('hex');
  wallets[address] = {
    balance: 0,
    miningStatus: false,
    lastMinedTimestamp: Date.now(),
    developerApiKey: req.apiKey,
    createdAt: new Date().toISOString()
  };
  saveData();
  res.json({ message: 'Wallet berhasil dibuat', address });
});

// Cek saldo
app.get('/api/v1/wallet/balance', authenticateAPI, (req, res) => {
  const { address } = req.query;
  const wallet = wallets[address];
  if (!wallet || wallet.developerApiKey !== req.apiKey) {
    return res.status(404).json({ error: 'Wallet tidak ditemukan atau bukan milik Anda' });
  }
  res.json({ address, balance: parseFloat(wallet.balance.toFixed(8)) });
});

// Info wallet
app.get('/api/v1/wallet/info', authenticateAPI, (req, res) => {
  const { address } = req.query;
  const wallet = wallets[address];
  if (!wallet || wallet.developerApiKey !== req.apiKey) {
    return res.status(404).json({ error: 'Wallet tidak ditemukan atau bukan milik Anda' });
  }
  res.json({
    address,
    balance: parseFloat(wallet.balance.toFixed(8)),
    miningStatus: wallet.miningStatus,
    createdAt: wallet.createdAt
  });
});

// Riwayat transaksi wallet
app.get('/api/v1/wallet/transactions', authenticateAPI, (req, res) => {
  const { address, limit = 20 } = req.query;
  const wallet = wallets[address];
  if (!wallet || wallet.developerApiKey !== req.apiKey) {
    return res.status(404).json({ error: 'Wallet tidak ditemukan atau bukan milik Anda' });
  }
  const txs = globalTransactions
    .filter(t => t.from === address || t.to === address)
    .slice(-parseInt(limit))
    .reverse();
  res.json({ address, transactions: txs });
});

// --- Cloud Mining ---
app.post('/api/v1/mining/start', authenticateAPI, (req, res) => {
  const { address } = req.body;
  const wallet = wallets[address];
  if (!wallet || wallet.developerApiKey !== req.apiKey) {
    return res.status(404).json({ error: 'Wallet tidak ditemukan atau bukan milik Anda' });
  }
  if (wallet.miningStatus) {
    return res.json({ message: 'Mining sudah aktif', address, status: true });
  }
  wallet.miningStatus = true;
  wallet.lastMinedTimestamp = Date.now();
  saveData();
  res.json({ message: 'Cloud Mining dimulai (1 MZU / 2 hari)', address, status: true });
});

app.post('/api/v1/mining/stop', authenticateAPI, (req, res) => {
  const { address } = req.body;
  const wallet = wallets[address];
  if (!wallet || wallet.developerApiKey !== req.apiKey) {
    return res.status(404).json({ error: 'Wallet tidak ditemukan' });
  }
  // Saat stop, claim dulu yang sudah terkumpul
  if (wallet.miningStatus) {
    let elapsed = (Date.now() - wallet.lastMinedTimestamp) / 1000;
    if (elapsed > MAX_ACCRUAL_SECONDS) elapsed = MAX_ACCRUAL_SECONDS;
    const pending = elapsed * RATE_PER_SECOND;
    if (pending > 0.00000001 && totalMined + pending <= TOTAL_SUPPLY) {
      wallet.balance += pending;
      totalMined += pending;
      const txData = {
        type: 'MINING',
        to: address,
        amount: parseFloat(pending.toFixed(8)),
        hash: generateHash(address + Date.now() + 'MINING'),
        timestamp: new Date().toISOString()
      };
      globalTransactions.push(txData);
      broadcastToClients({ event: 'new_tx', data: txData });
    }
  }
  wallet.miningStatus = false;
  saveData();
  res.json({
    message: 'Mining dihentikan. Koin yang sudah terkumpul diklaim otomatis.',
    address,
    status: false,
    balance: parseFloat(wallet.balance.toFixed(8))
  });
});

app.get('/api/v1/mining/status', authenticateAPI, (req, res) => {
  const { address } = req.query;
  const wallet = wallets[address];
  if (!wallet || wallet.developerApiKey !== req.apiKey) {
    return res.status(404).json({ error: 'Wallet tidak ditemukan' });
  }

  let pending = 0;
  if (wallet.miningStatus) {
    let elapsed = (Date.now() - wallet.lastMinedTimestamp) / 1000;
    if (elapsed > MAX_ACCRUAL_SECONDS) elapsed = MAX_ACCRUAL_SECONDS;
    pending = elapsed * RATE_PER_SECOND;
  }

  res.json({
    address,
    miningStatus: wallet.miningStatus,
    pendingReward: parseFloat(pending.toFixed(8)),
    balance: parseFloat(wallet.balance.toFixed(8)),
    rate: '1 MZU / 2 hari',
    totalSupply: TOTAL_SUPPLY,
    totalMined: parseFloat(totalMined.toFixed(8))
  });
});

app.post('/api/v1/mining/claim', authenticateAPI, (req, res) => {
  const { address } = req.body;
  const wallet = wallets[address];
  if (!wallet || wallet.developerApiKey !== req.apiKey) {
    return res.status(404).json({ error: 'Wallet tidak ditemukan' });
  }
  if (!wallet.miningStatus) {
    return res.status(400).json({ error: 'Mining belum dimulai. Panggil /mining/start dulu.' });
  }

  let elapsed = (Date.now() - wallet.lastMinedTimestamp) / 1000;
  if (elapsed > MAX_ACCRUAL_SECONDS) elapsed = MAX_ACCRUAL_SECONDS;
  const pending = elapsed * RATE_PER_SECOND;

  if (pending <= 0.00000001) {
    return res.status(400).json({ error: 'Belum ada koin yang bisa diklaim' });
  }
  if (totalMined + pending > TOTAL_SUPPLY) {
    return res.status(400).json({ error: 'Total supply sudah tercapai (500.000.000 MZU)' });
  }

  wallet.balance += pending;
  totalMined += pending;
  wallet.lastMinedTimestamp = Date.now();

  const txData = {
    type: 'MINING',
    to: address,
    amount: parseFloat(pending.toFixed(8)),
    hash: generateHash(address + Date.now() + 'MINING'),
    timestamp: new Date().toISOString()
  };
  globalTransactions.push(txData);
  broadcastToClients({ event: 'new_tx', data: txData });
  saveData();

  res.json({
    message: 'Klaim sukses',
    claimed: parseFloat(pending.toFixed(8)),
    balance: parseFloat(wallet.balance.toFixed(8)),
    totalMined: parseFloat(totalMined.toFixed(8))
  });
});

// --- Transfer Cepat ---
app.post('/api/v1/transfer', authenticateAPI, (req, res) => {
  const { fromAddress, toAddress, amount, memo } = req.body;
  const amountNum = parseFloat(amount);

  if (!wallets[fromAddress] || wallets[fromAddress].developerApiKey !== req.apiKey) {
    return res.status(404).json({ error: 'Wallet pengirim tidak valid / bukan milik Anda' });
  }
  if (!wallets[toAddress]) {
    return res.status(404).json({ error: 'Alamat dompet tujuan tidak ditemukan' });
  }
  if (isNaN(amountNum) || amountNum <= 0) {
    return res.status(400).json({ error: 'Jumlah tidak valid' });
  }
  if (wallets[fromAddress].balance < amountNum) {
    return res.status(400).json({ error: 'Saldo tidak cukup' });
  }

  wallets[fromAddress].balance -= amountNum;
  wallets[toAddress].balance += amountNum;

  const txData = {
    type: 'TRANSFER',
    from: fromAddress,
    to: toAddress,
    amount: amountNum,
    memo: memo || null,
    hash: generateHash(fromAddress + toAddress + amountNum + Date.now()),
    timestamp: new Date().toISOString()
  };
  globalTransactions.push(txData);
  broadcastToClients({ event: 'new_tx', data: txData });
  saveData();

  res.json({
    message: 'Transfer berhasil',
    txHash: txData.hash,
    sisaSaldo: parseFloat(wallets[fromAddress].balance.toFixed(8))
  });
});

// Transfer batch
app.post('/api/v1/transfer/batch', authenticateAPI, (req, res) => {
  const { fromAddress, transfers } = req.body;
  if (!Array.isArray(transfers) || transfers.length === 0) {
    return res.status(400).json({ error: 'transfers harus array' });
  }
  if (!wallets[fromAddress] || wallets[fromAddress].developerApiKey !== req.apiKey) {
    return res.status(404).json({ error: 'Wallet pengirim tidak valid' });
  }

  let totalAmount = 0;
  for (const t of transfers) {
    const amt = parseFloat(t.amount);
    if (!wallets[t.toAddress] || isNaN(amt) || amt <= 0) {
      return res.status(400).json({ error: `Transfer invalid ke ${t.toAddress}` });
    }
    totalAmount += amt;
  }
  if (wallets[fromAddress].balance < totalAmount) {
    return res.status(400).json({ error: 'Saldo tidak cukup untuk batch transfer' });
  }

  const results = [];
  for (const t of transfers) {
    const amountNum = parseFloat(t.amount);
    wallets[fromAddress].balance -= amountNum;
    wallets[t.toAddress].balance += amountNum;

    const txData = {
      type: 'TRANSFER',
      from: fromAddress,
      to: t.toAddress,
      amount: amountNum,
      hash: generateHash(fromAddress + t.toAddress + amountNum + Date.now()),
      timestamp: new Date().toISOString()
    };
    globalTransactions.push(txData);
    broadcastToClients({ event: 'new_tx', data: txData });
    results.push({ to: t.toAddress, amount: amountNum, txHash: txData.hash });
  }
  saveData();

  res.json({
    message: 'Batch transfer berhasil',
    results,
    sisaSaldo: parseFloat(wallets[fromAddress].balance.toFixed(8))
  });
});

// ==========================================
// 3. EXPLORER & LIVE FEED (Publik)
// ==========================================

app.get('/api/explorer/search', (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'Query diperlukan' });

  const txResult = globalTransactions.find(tx => tx.hash === query);
  if (txResult) return res.json({ type: 'transaction', data: txResult });

  if (wallets[query]) {
    return res.json({
      type: 'wallet',
      data: {
        address: query,
        balance: parseFloat(wallets[query].balance.toFixed(8)),
        totalTx: globalTransactions.filter(t => t.from === query || t.to === query).length,
        miningStatus: wallets[query].miningStatus
      }
    });
  }
  res.status(404).json({ error: 'Data tidak ditemukan' });
});

app.get('/api/explorer/stats', (req, res) => {
  res.json({
    totalSupply: TOTAL_SUPPLY,
    totalMined: parseFloat(totalMined.toFixed(8)),
    remainingSupply: parseFloat((TOTAL_SUPPLY - totalMined).toFixed(8)),
    totalWallets: Object.keys(wallets).length,
    totalTransactions: globalTransactions.length,
    totalDevelopers: Object.keys(developers).length,
    miningRate: '1 MZU / 2 hari per wallet'
  });
});

app.get('/api/explorer/transactions/latest', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const txs = globalTransactions.slice(-limit).reverse();
  res.json({ transactions: txs });
});

app.get('/api/explorer/top-wallets', (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const sorted = Object.entries(wallets)
    .map(([address, w]) => ({ address, balance: parseFloat(w.balance.toFixed(8)) }))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, limit);
  res.json({ topWallets: sorted });
});

// Server-Sent Events untuk Live Feed
app.get('/api/explorer/feed', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clients.push(res);
  req.on('close', () => {
    clients = clients.filter(c => c !== res);
  });
});

// Root → frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`  Mizu Coin API Gateway v1.1`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Total Supply: ${TOTAL_SUPPLY.toLocaleString()} MZU`);
  console.log(`  Mining Rate: 1 MZU / 2 hari`);
  console.log(`========================================`);
});

// Graceful save on exit
process.on('SIGINT', () => { saveData(); process.exit(); });
process.on('SIGTERM', () => { saveData(); process.exit(); });
