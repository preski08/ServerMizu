const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// --- DATABASE SEMENTARA (Gunakan MongoDB/PostgreSQL untuk produksi) ---
let wallets = {}; // { address: { apiKey, token, balance, miningStatus, lastMined, transactions: [] } }
let globalTransactions = []; // Ledger untuk Explorer
let clients = []; // Untuk Real-time SSE

// Konstanta Mining
const RATE_PER_SECOND = 1 / 86400; // 1 MZU per hari
const MAX_ACCRUAL_SECONDS = 86400;

// Helper: Generate Address, API Key, Token
function generateWallet() {
    const address = 'mizu' + crypto.randomBytes(20).toString('hex');
    const apiKey = crypto.randomBytes(16).toString('hex');
    const token = crypto.randomBytes(32).toString('hex');
    return { address, apiKey, token };
}

function generateHash(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

// --- 1. GENERATE WALLET (API & TOKEN) ---
app.post('/api/wallet/generate', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username dan password wajib diisi" });

    // Cek apakah username sudah ada
    const existing = Object.values(wallets).find(w => w.username === username);
    if (existing) return res.status(400).json({ error: "Username sudah terdaftar" });

    const { address, apiKey, token } = generateWallet();
    
    wallets[address] = {
        username,
        password: generateHash(password),
        apiKey,
        token,
        balance: 0,
        miningStatus: false,
        lastMinedTimestamp: Date.now(),
        transactions: []
    };

    res.json({ message: "Wallet berhasil dibuat", address, apiKey, token });
});

// Login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const wallet = Object.values(wallets).find(w => w.username === username && w.password === generateHash(password));
    
    if (!wallet) return res.status(401).json({ error: "Login gagal" });
    
    const address = Object.keys(wallets).find(addr => wallets[addr] === wallet);
    res.json({ message: "Login sukses", address, apiKey: wallet.apiKey, token: wallet.token, balance: wallet.balance });
});

// Middleware Autentikasi
function authenticate(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    const address = Object.keys(wallets).find(addr => wallets[addr].apiKey === apiKey);
    if (!address) return res.status(403).json({ error: "API Key tidak valid" });
    req.walletAddress = address;
    req.wallet = wallets[address];
    next();
}

// --- 2. CLOUD MINING ---
app.post('/api/mining/start', authenticate, (req, res) => {
    if (req.wallet.miningStatus) return res.status(400).json({ error: "Mining sudah berjalan" });
    req.wallet.miningStatus = true;
    req.wallet.lastMinedTimestamp = Date.now();
    res.json({ message: "Cloud Mining dimulai", status: req.wallet.miningStatus });
});

app.post('/api/mining/stop', authenticate, (req, res) => {
    req.wallet.miningStatus = false;
    res.json({ message: "Cloud Mining dihentikan", status: req.wallet.miningStatus });
});

app.get('/api/mining/status', authenticate, (req, res) => {
    if (!req.wallet.miningStatus) return res.json({ status: false, pending: 0 });

    let elapsed = (Date.now() - req.wallet.lastMinedTimestamp) / 1000;
    if (elapsed > MAX_ACCRUAL_SECONDS) elapsed = MAX_ACCRUAL_SECONDS;
    const pending = elapsed * RATE_PER_SECOND;

    res.json({
        status: true,
        pending: parseFloat(pending.toFixed(8)),
        maxReached: elapsed >= MAX_ACCRUAL_SECONDS
    });
});

app.post('/api/mining/claim', authenticate, (req, res) => {
    if (!req.wallet.miningStatus) return res.status(400).json({ error: "Mining belum dimulai" });

    let elapsed = (Date.now() - req.wallet.lastMinedTimestamp) / 1000;
    if (elapsed > MAX_ACCRUAL_SECONDS) elapsed = MAX_ACCRUAL_SECONDS;
    const pending = elapsed * RATE_PER_SECOND;

    if (pending <= 0.00000001) return res.status(400).json({ error: "Belum ada koin" });

    req.wallet.balance += pending;
    req.wallet.lastMinedTimestamp = Date.now();

    const txHash = generateHash(req.walletAddress + Date.now() + "MINING");
    const txData = {
        type: "MINING",
        to: req.walletAddress,
        amount: parseFloat(pending.toFixed(8)),
        hash: txHash,
        timestamp: new Date().toISOString()
    };
    
    globalTransactions.push(txData);
    req.wallet.transactions.push(txData);

    // Broadcast ke Real-time
    broadcastToClients({ event: 'new_tx', data: txData });

    res.json({ message: "Klaim sukses", balance: parseFloat(req.wallet.balance.toFixed(8)) });
});

// --- 3. TRANSFER CEPAT ---
app.post('/api/transfer', authenticate, (req, res) => {
    const { toAddress, amount } = req.body;
    const amountNum = parseFloat(amount);

    if (!wallets[toAddress]) return res.status(404).json({ error: "Alamat dompet tujuan tidak ditemukan" });
    if (req.wallet.balance < amountNum) return res.status(400).json({ error: "Saldo tidak cukup" });
    if (amountNum <= 0) return res.status(400).json({ error: "Jumlah tidak valid" });

    req.wallet.balance -= amountNum;
    wallets[toAddress].balance += amountNum;

    const txHash = generateHash(req.walletAddress + toAddress + amountNum + Date.now());
    const txData = {
        type: "TRANSFER",
        from: req.walletAddress,
        to: toAddress,
        amount: amountNum,
        hash: txHash,
        timestamp: new Date().toISOString()
    };

    globalTransactions.push(txData);
    req.wallet.transactions.push(txData);
    wallets[toAddress].transactions.push(txData);

    // Broadcast ke Real-time
    broadcastToClients({ event: 'new_tx', data: txData });

    res.json({ message: "Transfer berhasil", txHash, sisaSaldo: parseFloat(req.wallet.balance.toFixed(8)) });
});

// --- 4. EXPLORER / SEARCH BLOCKCHAIN ---
app.get('/api/explorer/search', (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).json({ error: "Query diperlukan" });

    // Cari berdasarkan Hash TX
    const txResult = globalTransactions.find(tx => tx.hash === query);
    if (txResult) return res.json({ type: 'transaction', data: txResult });

    // Cari berdasarkan Alamat Wallet
    if (wallets[query]) {
        return res.json({ 
            type: 'wallet', 
            data: { 
                address: query, 
                username: wallets[query].username,
                balance: parseFloat(wallets[query].balance.toFixed(8)),
                totalTx: wallets[query].transactions.length
            } 
        });
    }

    res.status(404).json({ error: "Data tidak ditemukan" });
});

// --- 5. REAL-TIME INFO (Server-Sent Events) ---
app.get('/api/explorer/feed', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    clients.push(res);

    req.on('close', () => {
        clients = clients.filter(client => client !== res);
    });
});

function broadcastToClients(data) {
    clients.forEach(client => {
        client.write(`data: ${JSON.stringify(data)}\n\n`);
    });
}

// Jalankan Server
app.listen(PORT, () => {
    console.log(`Server Mizu Coin berjalan di port ${PORT}`);
});
