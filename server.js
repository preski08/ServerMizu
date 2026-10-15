const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser');

const app = express();
const PORT = 3000;

app.use(bodyParser.json());
app.use(express.static('public'));

// Database Sementara (In-Memory)
let users = {}; 
let transactions = [];

// --- KONFIGURASI MINING ---
const COINS_PER_DAY = 1;
const SECONDS_PER_DAY = 86400;
const RATE_PER_SECOND = COINS_PER_DAY / SECONDS_PER_DAY; // ~0.00001157 MZU/detik
const MAX_ACCRUAL_SECONDS = 86400; // Maksimal akumulasi 24 jam

// Fungsi Helper: Generate SHA-256
function generateHash(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

// 1. API REGISTER
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (users[username]) return res.status(400).json({ error: "Username sudah dipakai" });

    const apiKey = generateHash(username + Date.now() + "MIZU_API");
    const token = generateHash(apiKey + "TOKEN");

    users[username] = {
        password: generateHash(password),
        apiKey: apiKey,
        token: token,
        balance: 0,
        lastMinedTimestamp: Date.now() // Waktu mulai akumulasi
    };

    res.json({ message: "Registrasi berhasil", apiKey, token });
});

// 2. API LOGIN
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = users[username];

    if (!user || user.password !== generateHash(password)) {
        return res.status(401).json({ error: "ID atau Password salah" });
    }

    res.json({ 
        message: "Login berhasil", 
        apiKey: user.apiKey, 
        token: user.token,
        balance: user.balance,
        lastMined: user.lastMinedTimestamp
    });
});

// Middleware Autentikasi (Cek API Key)
function authenticate(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: "API Key diperlukan" });

    const username = Object.keys(users).find(u => users[u].apiKey === apiKey);
    if (!username) return res.status(403).json({ error: "API Key tidak valid" });

    req.user = users[username];
    req.username = username;
    next();
}

// 3. API CEK STATUS MINING (Untuk Update UI)
app.get('/api/status', authenticate, (req, res) => {
    const now = Date.now();
    let elapsedSeconds = (now - req.user.lastMinedTimestamp) / 1000;
    
    if (elapsedSeconds > MAX_ACCRUAL_SECONDS) elapsedSeconds = MAX_ACCRUAL_SECONDS;

    const pendingRewards = elapsedSeconds * RATE_PER_SECOND;

    res.json({
        balance: req.user.balance,
        pendingRewards: parseFloat(pendingRewards.toFixed(8)),
        lastMinedTimestamp: req.user.lastMinedTimestamp,
        maxAccrualReached: elapsedSeconds >= MAX_ACCRUAL_SECONDS
    });
});

// 4. API CLAIM (Ambil koin yang sudah terkumpul)
app.post('/api/claim', authenticate, (req, res) => {
    const now = Date.now();
    let elapsedSeconds = (now - req.user.lastMinedTimestamp) / 1000;
    
    if (elapsedSeconds > MAX_ACCRUAL_SECONDS) elapsedSeconds = MAX_ACCRUAL_SECONDS;

    const pendingRewards = elapsedSeconds * RATE_PER_SECOND;

    if (pendingRewards <= 0.00000001) {
        return res.status(400).json({ error: "Belum ada koin yang terkumpul. Tunggu beberapa detik." });
    }

    req.user.balance += pendingRewards;
    req.user.lastMinedTimestamp = now; // Reset waktu akumulasi setelah klaim

    transactions.push({
        type: "MINING",
        to: req.username,
        amount: parseFloat(pendingRewards.toFixed(8)),
        hash: generateHash(req.username + now),
        timestamp: new Date().toISOString()
    });

    res.json({ 
        message: `Klaim sukses! +${pendingRewards.toFixed(8)} MZU`, 
        balance: parseFloat(req.user.balance.toFixed(8)) 
    });
});

// 5. API TRANSFER (Kirim Koin ke User Lain)
app.post('/api/transfer', authenticate, (req, res) => {
    const { toUsername, amount } = req.body;
    const amountNum = parseFloat(amount);

    if (!users[toUsername]) return res.status(404).json({ error: "Penerima tidak ditemukan" });
    if (req.user.balance < amountNum) return res.status(400).json({ error: "Saldo tidak cukup" });
    if (amountNum <= 0) return res.status(400).json({ error: "Jumlah tidak valid" });

    req.user.balance -= amountNum;
    users[toUsername].balance += amountNum;

    const txHash = generateHash(req.username + toUsername + amountNum + Date.now());
    
    transactions.push({
        type: "TRANSFER",
        from: req.username,
        to: toUsername,
        amount: amountNum,
        hash: txHash,
        timestamp: new Date().toISOString()
    });

    res.json({ 
        message: "Transfer berhasil", 
        txHash: txHash,
        sisaSaldo: parseFloat(req.user.balance.toFixed(8))
    });
});

// 6. API RIWAYAT TRANSAKSI
app.get('/api/transactions', authenticate, (req, res) => {
    const userTxs = transactions.filter(tx => tx.from === req.username || tx.to === req.username);
    res.json({ transactions: userTxs.reverse() });
});

// Jalankan Server
app.listen(PORT, () => {
    console.log(`Server Mizu Coin berjalan di http://localhost:${PORT}`);
});