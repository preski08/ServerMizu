const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// --- DATABASE SEMENTARA ---
let developers = {}; // { apiKey: { username, password, token, wallets: [] } }
let wallets = {}; // { address: { balance, miningStatus, lastMined, developerApiKey } }
let globalTransactions = []; // Ledger untuk Explorer
let clients = []; // Untuk Real-time SSE

const RATE_PER_SECOND = 1 / 86400; // 1 MZU per hari
const MAX_ACCRUAL_SECONDS = 86400;

// Helper: Generate Kredensial Developer
function generateDeveloperCredentials() {
    const apiKey = 'mizu_pk_' + crypto.randomBytes(16).toString('hex');
    const token = 'mizu_sk_' + crypto.randomBytes(32).toString('hex');
    return { apiKey, token };
}

function generateHash(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

// ==========================================
// 1. API UNTUK DEVELOPER (Aplikasi Anda)
// ==========================================

// Register Developer (Mendapatkan API Key & Token)
app.post('/api/developer/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username dan password wajib diisi" });

    const existing = Object.values(developers).find(d => d.username === username);
    if (existing) return res.status(400).json({ error: "Username sudah terdaftar" });

    const { apiKey, token } = generateDeveloperCredentials();
    
    developers[apiKey] = {
        username,
        password: generateHash(password),
        token,
        createdAt: new Date().toISOString()
    };

    res.json({ message: "Registrasi Developer Berhasil", apiKey, token });
});

// Login Developer
app.post('/api/developer/login', (req, res) => {
    const { username, password } = req.body;
    const apiKey = Object.keys(developers).find(key => developers[key].username === username && developers[key].password === generateHash(password));
    
    if (!apiKey) return res.status(401).json({ error: "Login gagal" });
    
    res.json({ message: "Login sukses", apiKey, token: developers[apiKey].token });
});

// Middleware Autentikasi API Key
function authenticateAPI(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || !developers[apiKey]) {
        return res.status(403).json({ error: "API Key tidak valid atau tidak ditemukan" });
    }
    req.developer = developers[apiKey];
    req.apiKey = apiKey;
    next();
}

// ==========================================
// 2. API UNTUK INTEGRASI (Wallet, Mining, Transfer)
// ==========================================

// A. Generate Wallet Mizu (Untuk user aplikasi Anda)
app.post('/api/v1/wallet/create', authenticateAPI, (req, res) => {
    const address = 'mizu' + crypto.randomBytes(20).toString('hex');
    wallets[address] = {
        balance: 0,
        miningStatus: false,
        lastMinedTimestamp: Date.now(),
        developerApiKey: req.apiKey
    };
    res.json({ message: "Wallet berhasil dibuat", address });
});

// B. Cloud Mining (Start, Stop, Claim)
app.post('/api/v1/mining/start', authenticateAPI, (req, res) => {
    const { address } = req.body;
    if (!wallets[address] || wallets[address].developerApiKey !== req.apiKey) {
        return res.status(404).json({ error: "Wallet tidak ditemukan atau bukan milik Anda" });
    }
    wallets[address].miningStatus = true;
    wallets[address].lastMinedTimestamp = Date.now();
    res.json({ message: "Mining dimulai", address, status: true });
});

app.post('/api/v1/mining/stop', authenticateAPI, (req, res) => {
    const { address } = req.body;
    if (!wallets[address]) return res.status(404).json({ error: "Wallet tidak ditemukan" });
    wallets[address].miningStatus = false;
    res.json({ message: "Mining dihentikan", address, status: false });
});

app.post('/api/v1/mining/claim', authenticateAPI, (req, res) => {
    const { address } = req.body;
    const wallet = wallets[address];
    if (!wallet || wallet.developerApiKey !== req.apiKey) return res.status(404).json({ error: "Wallet tidak ditemukan" });
    if (!wallet.miningStatus) return res.status(400).json({ error: "Mining belum dimulai" });

    let elapsed = (Date.now() - wallet.lastMinedTimestamp) / 1000;
    if (elapsed > MAX_ACCRUAL_SECONDS) elapsed = MAX_ACCRUAL_SECONDS;
    const pending = elapsed * RATE_PER_SECOND;

    if (pending <= 0.00000001) return res.status(400).json({ error: "Belum ada koin" });

    wallet.balance += pending;
    wallet.lastMinedTimestamp = Date.now();

    const txData = {
        type: "MINING",
        to: address,
        amount: parseFloat(pending.toFixed(8)),
        hash: generateHash(address + Date.now() + "MINING"),
        timestamp: new Date().toISOString()
    };
    
    globalTransactions.push(txData);
    broadcastToClients({ event: 'new_tx', data: txData });

    res.json({ message: "Klaim sukses", balance: parseFloat(wallet.balance.toFixed(8)) });
});

// C. Transfer Cepat
app.post('/api/v1/transfer', authenticateAPI, (req, res) => {
    const { fromAddress, toAddress, amount } = req.body;
    const amountNum = parseFloat(amount);

    if (!wallets[fromAddress] || wallets[fromAddress].developerApiKey !== req.apiKey) return res.status(404).json({ error: "Wallet pengirim tidak valid" });
    if (!wallets[toAddress]) return res.status(404).json({ error: "Alamat dompet tujuan tidak ditemukan" });
    if (wallets[fromAddress].balance < amountNum) return res.status(400).json({ error: "Saldo tidak cukup" });
    if (amountNum <= 0) return res.status(400).json({ error: "Jumlah tidak valid" });

    wallets[fromAddress].balance -= amountNum;
    wallets[toAddress].balance += amountNum;

    const txData = {
        type: "TRANSFER",
        from: fromAddress,
        to: toAddress,
        amount: amountNum,
        hash: generateHash(fromAddress + toAddress + amountNum + Date.now()),
        timestamp: new Date().toISOString()
    };

    globalTransactions.push(txData);
    broadcastToClients({ event: 'new_tx', data: txData });

    res.json({ message: "Transfer berhasil", txHash: txData.hash, sisaSaldo: parseFloat(wallets[fromAddress].balance.toFixed(8)) });
});

// ==========================================
// 3. API UNTUK EXPLORER & LIVE FEED (Publik)
// ==========================================

app.get('/api/explorer/search', (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).json({ error: "Query diperlukan" });

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

    res.status(404).json({ error: "Data tidak ditemukan" });
});

app.get('/api/explorer/feed', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    clients.push(res);
    req.on('close', () => { clients = clients.filter(client => client !== res); });
});

function broadcastToClients(data) {
    clients.forEach(client => client.write(`data: ${JSON.stringify(data)}\n\n`));
}

// Jalankan Server
app.listen(PORT, () => {
    console.log(`Mizu API Gateway berjalan di port ${PORT}`);
});
