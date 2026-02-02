const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = 4173;
const DIST = path.join(__dirname, 'dist');
const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const AUTH_USERNAME = process.env.AUTH_USERNAME || 'admin';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'changeme';
const COOKIE_SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'monochrome_auth';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

const MIME = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.wasm': 'application/wasm',
    '.xml': 'application/xml',
    '.txt': 'text/plain',
};

// --- Auth helpers ---

function sign(value) {
    return value + '.' + crypto.createHmac('sha256', COOKIE_SECRET).update(value).digest('hex');
}

function verify(signed) {
    if (!signed) return false;
    const dot = signed.lastIndexOf('.');
    if (dot === -1) return false;
    const value = signed.substring(0, dot);
    return sign(value) === signed;
}

function getCookie(req, name) {
    const header = req.headers.cookie || '';
    const match = header
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith(name + '='));
    return match ? decodeURIComponent(match.split('=')[1]) : null;
}

function parseForm(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => resolve(new URLSearchParams(body)));
    });
}

function checkCredentials(username, password) {
    const a = Buffer.from(username);
    const b = Buffer.from(AUTH_USERNAME);
    const c = Buffer.from(password);
    const d = Buffer.from(AUTH_PASSWORD);
    const userOk = a.length === b.length && crypto.timingSafeEqual(a, b);
    const passOk = c.length === d.length && crypto.timingSafeEqual(c, d);
    return userOk && passOk;
}

function sessionCookie(value, maxAge) {
    return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

// --- Login page ---

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login - Monochrome</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Inter,sans-serif;background:#000;color:#fafafa;display:flex;align-items:center;justify-content:center;min-height:100vh}
.login{background:#111;padding:2.5rem;border-radius:0.75rem;width:340px;border:1px solid #27272a;box-shadow:0 20px 25px -5px rgba(0,0,0,.3);animation:scale-in .2s ease}
@keyframes scale-in{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}
.logo{display:flex;justify-content:center;margin-bottom:1.5rem}
.logo svg{width:48px;height:48px}
h1{font-size:1.25rem;margin-bottom:2rem;text-align:center;font-weight:500;letter-spacing:.5px}
input{width:100%;padding:.75rem 1rem;margin-bottom:1rem;background:#27272a;border:1px solid #3f3f46;border-radius:0.75rem;color:#fafafa;font-family:Inter,sans-serif;font-size:.95rem;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:#71717a;box-shadow:0 0 0 3px rgba(250,250,250,.08)}
input::placeholder{color:#71717a}
button{width:100%;padding:.75rem;margin-top:.5rem;background:#fafafa;color:#000;border:none;border-radius:9999px;font-family:Inter,sans-serif;font-size:.95rem;font-weight:600;cursor:pointer;transition:all .3s cubic-bezier(.4,0,.2,1);box-shadow:0 1px 2px rgba(0,0,0,.05)}
button:hover{filter:brightness(0.85);transform:translateY(-1px);box-shadow:0 0 15px rgba(250,250,250,.15)}
button:active{transform:scale(.96) translateY(0)}
.error{color:#ef4444;font-size:.85rem;margin-bottom:1rem;text-align:center}
</style>
</head>
<body>
<form class="login" method="POST" action="/login">
<div class="logo"><svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="14.75 14.75 70.5 70.5"><g fill="white"><path d="M38.25 14.75H85.25V61.75H61.75V38.25H38.25ZM14.75 38.25H38.25V61.75H61.75V85.25H14.75Z"/></g></svg></div>
<h1>Monochrome</h1>
<!--ERROR-->
<input type="text" name="username" placeholder="Username" required autofocus>
<input type="password" name="password" placeholder="Password" required>
<button type="submit">Login</button>
</form>
</body>
</html>`;

function loginPage(error) {
    const errorHtml = error ? `<p class="error">${error}</p>` : '';
    return LOGIN_PAGE.replace('<!--ERROR-->', errorHtml);
}

// --- Static file server ---

function serveFile(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const stream = fs.createReadStream(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    stream.pipe(res);
    stream.on('error', () => {
        res.writeHead(500);
        res.end();
    });
}

// --- Server ---

const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];

    // --- Auth gate ---
    if (AUTH_ENABLED) {
        if (req.method === 'POST' && url === '/login') {
            const params = await parseForm(req);
            if (checkCredentials(params.get('username') || '', params.get('password') || '')) {
                const token = crypto.randomBytes(16).toString('hex');
                res.writeHead(302, {
                    Location: '/',
                    'Set-Cookie': sessionCookie(sign(token), COOKIE_MAX_AGE),
                });
                return res.end();
            }
            res.writeHead(401, { 'Content-Type': 'text/html' });
            return res.end(loginPage('Invalid credentials'));
        }

        if (url === '/logout') {
            res.writeHead(302, {
                Location: '/',
                'Set-Cookie': sessionCookie('', 0),
            });
            return res.end();
        }

        if (!verify(getCookie(req, COOKIE_NAME))) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(loginPage());
        }
    }

    // --- Serve static files from dist/ ---
    let filePath = path.join(DIST, url);

    // Security: prevent path traversal
    if (!filePath.startsWith(DIST)) {
        res.writeHead(403);
        return res.end();
    }

    try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    } catch {
        // not found — fall through to SPA fallback
    }

    try {
        if (fs.statSync(filePath).isFile()) return serveFile(res, filePath);
    } catch {
        // not found
    }

    // SPA fallback
    const index = path.join(DIST, 'index.html');
    try {
        if (fs.statSync(index).isFile()) return serveFile(res, index);
    } catch {
        res.writeHead(404);
        res.end('Not found');
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Monochrome running on http://0.0.0.0:${PORT}`);
    if (AUTH_ENABLED) console.log('Authentication enabled');
});
