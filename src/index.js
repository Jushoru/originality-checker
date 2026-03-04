const express = require('express');
const path = require('path');
const fs = require('fs');
const morgan = require('morgan');
const helmet = require('helmet');

const authMiddleware = require('./middleware/auth');
const { run, get, all } = require('./db');

const PUBLIC_DIR = path.join(__dirname, 'publications');
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const app = express();
app.use(helmet());
app.use(express.json({ limit: '70mb' }));

// Morgan: фильтруем header Authorization (в логах не должно быть токена)
morgan.token('filtered-authorization', (req) => {
    const a = req.get('authorization') || '';
    if (!a) return '';
    return '[REDACTED]';
});
app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" :filtered-authorization'));

async function deleteFileFromPublications(filePath) {
    try {
        await fs.promises.unlink(filePath);
    } catch (e) {
        if (e && e.code === 'ENOENT') return;
        console.error('Failed to delete file:', filePath, e);
    }
}

function isValidPdf(buffer) {
    if (!buffer || buffer.length < 8) return false;

    const header = buffer.subarray(0, 4).toString('utf8');
    if (header !== '%PDF') return false;

    const tail = buffer.subarray(-1024).toString('utf8');
    if (!tail.includes('%%EOF')) return false;

    return true;
}

function sanitizeId(id) {
    if (!id || typeof id !== 'string') return null;
    const sanitized = id.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(sanitized)) return null;
    return sanitized;
}

// Запись лога в БД
async function logAction(action_type, req, file_id = null) {
    const ip = req.ip || req.connection.remoteAddress || '';
    const ua = req.get('user-agent') || '';
    const ts = (new Date()).toISOString();
    await run(`INSERT INTO logs (action_type, ip, user_agent, file_id, ts) VALUES (?, ?, ?, ?, ?)`,
        [action_type, ip, ua, file_id, ts]);
}

// Новый endpoint: отправка файла из 1С в JSON (base64)
// Content-Type: application/json
// Body:
// {
//   "file": "<BASE64 PDF>",
//   "file_id": "...",
//   "document_id": "...",
//   "mime_type": "pdf" // optional
// }
app.post('/api/upload', authMiddleware, async (req, res) => {
    const tmpPaths = []; // для отслеживания tmp-файлов
    try {
        const { file_id, document_id, mime_type, file } = req.body || {};

        const safeFileId = sanitizeId(file_id);
        if (!safeFileId) return res.status(400).json({ error: 'invalid file_id' });

        const safeDocId = sanitizeId(document_id);
        if (!safeDocId) return res.status(400).json({ error: 'invalid file_id' });

        const storedPath = path.join(PUBLIC_DIR, `${safeFileId}.pdf`);
        const tmpPath = storedPath + '.tmp';
        tmpPaths.push(tmpPath);

        if (!file) return res.status(400).json({ error: 'missing file' });
        const pdfBuffer = Buffer.from(file.split('base64,').pop(), 'base64');

        if (!isValidPdf(pdfBuffer)) {
            return res.status(400).json({ error: 'file is not a valid PDF' });
        }

        await run('BEGIN');

        // 1) Если в БД уже есть запись с этим file_id
        const existingByFileId = await get(`SELECT * FROM publications WHERE file_id = ?`, [safeFileId]);
        let message = '';
        if (existingByFileId) {
            const isActual = await get(`SELECT * FROM publications WHERE file_type = 'actual' AND file_id = ?`, [safeFileId]);
            if (isActual) {
                await run(`UPDATE publications SET date_of_creation=?, status=?, mime_type=?, file_type=? WHERE file_id=?`,
                    [new Date().toISOString(), 'fulfilled', mime_type || 'pdf', 'actual', safeFileId]);
            } else {
                await run(`UPDATE publications SET file_type='deleted' WHERE document_id=? AND file_type='actual'`, [safeDocId]);
                await run(`UPDATE publications SET date_of_creation=?, status=?, mime_type=?, file_type=? WHERE file_id=?`,
                    [new Date().toISOString(), 'pending', mime_type || 'pdf', 'actual', safeFileId]);
            }
            message = 'file overwritten';
        }

        // 2) Иначе — если есть запись с таким document_id и file_type == 'actual'
        const existingByDoc = await get(`SELECT * FROM publications WHERE document_id=? AND file_type='actual'`, [safeDocId]);
        if (!message && existingByDoc) {
            await run(`UPDATE publications SET file_type='deleted' WHERE document_id=? AND file_type='actual'`, [safeDocId]);
            const oldPath = path.join(PUBLIC_DIR, `${existingByDoc.file_id}.pdf`);
            await deleteFileFromPublications(oldPath);
            await run(`INSERT OR REPLACE INTO publications (file_id, document_id, file_type, date_of_creation, status, mime_type) VALUES (?, ?, ?, ?, ?, ?)`,
                [safeFileId, safeDocId, 'actual', new Date().toISOString(), 'pending', mime_type || 'pdf']);
            message = 'replaced old file (by document_id) with new file_id (pending QR)';
        }

        // 3) Первая публикация
        if (!message) {
            await run(`INSERT INTO publications (file_id, document_id, file_type, date_of_creation, status, mime_type) VALUES (?, ?, ?, ?, ?, ?)`,
                [safeFileId, safeDocId, 'actual', new Date().toISOString(), 'pending', mime_type || 'pdf']);
            message = 'file saved (pending QR)';
        }

        await fs.promises.writeFile(tmpPath, pdfBuffer);

        await logAction('upload', req, safeFileId);

        await run('COMMIT');

        await fs.promises.rename(tmpPath, storedPath);

        const link = `${req.protocol}://${req.get('host')}/publications/${encodeURIComponent(safeFileId)}`;
        return res.json({ message, file_id: safeFileId, link });

    } catch (err) {
        await run('ROLLBACK').catch(() => {});
        for (const tmpPath of tmpPaths) await deleteFileFromPublications(tmpPath);
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
});

// Endpoint: soft delete (actual -> deleted)
app.patch('/api/publications/:file_id/delete', authMiddleware, async (req, res) => {
    const { file_id } = req.params;
    const safeFileId = sanitizeId(file_id);
    if (!safeFileId) return res.status(400).json({ error: 'invalid file_id' });

    const storedPath = path.join(PUBLIC_DIR, `${safeFileId}.pdf`);

    try {
        await run('BEGIN TRANSACTION')

        const rec = await get(`SELECT * FROM publications WHERE file_id = ?`, [safeFileId]);
        if (!rec) return res.status(404).json({ error: 'file not found' });
        if (rec.file_type === 'deleted')  return res.status(400).json({ error: 'file already deleted' });

        await run(`UPDATE publications SET file_type = 'deleted' WHERE file_id = ?`,[safeFileId]);
        await deleteFileFromPublications(storedPath);
        await logAction('delete', req, safeFileId);

        await run('COMMIT')

        return res.json({ message: 'file marked as deleted', file_id: safeFileId});

    } catch (err) {
        await run('ROLLBACK').catch(() => {});
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
});

// Endpoint: get file by file_id (это публичная ссылка, которую даём в 1С)
// Поведение при запросе:
// - Если в publications есть запись file_id и file_type == 'actual' -> отдаем файл
// - Если запись была (file_type == 'deleted') -> возвращаем текст "The printed form is not relevant" (HTTP 410)
// - Если записи нет -> 404 "Printable form not found"
app.get('/publications/:file_id', async (req, res) => {
    try {
        const { file_id } = req.params;
        const safeFileId = sanitizeId(file_id)
        if (!safeFileId) return res.status(400).json({ error: 'invalid file_id' });

        const rec = await get(`SELECT * FROM publications WHERE file_id = ?`, [safeFileId]);
        if (!rec) return res.status(404).send('Printable form not found');

        if (rec.file_type !== 'actual') {
            // История — файл есть, но отмечен как deleted
            const actualFile = await get(`SELECT * FROM publications WHERE document_id = ? AND file_type = 'actual'`, [rec.document_id])
            if (actualFile) return res.status(410).send('The printed form is not relevant');
            else return res.status(410).send('The printed form is not relevant, request a new commercial invoice');
        }
        const filePath = path.join(PUBLIC_DIR, `${safeFileId}.pdf`);

        try {
            await fs.promises.access(filePath);
        } catch {
            return res.status(410).send('The printed form is not relevant');
        }

        await logAction('view', req, safeFileId);

        res.sendFile(filePath);
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// Запросы отладки

// Endpoint: получить статус по file_id (полезно для отладки)
app.get('/api/status/:file_id', authMiddleware, async (req, res) => {
    const { file_id } = req.params;
    const safeFileId = sanitizeId(file_id)
    if (!safeFileId) return res.status(400).json({ error: 'invalid file_id' });

    const rec = await get(`SELECT * FROM publications WHERE file_id = ?`, [safeFileId]);
    if (!rec) return res.status(404).json({ error: 'not found' });
    res.json(rec);
});

// Endpoint: список логов (только для админов/для отладки)
app.get('/api/logs', authMiddleware, async (req, res) => {
    const rows = await all(`SELECT * FROM logs ORDER BY ts DESC LIMIT 500`);
    res.json(rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Publication service started on port ${PORT}`);
    console.log(`Publications dir: ${PUBLIC_DIR}`);
});