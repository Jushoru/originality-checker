const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const morgan = require('morgan');
const helmet = require('helmet');
const bodyParser = require('body-parser');

const authMiddleware = require('./middleware/auth');
const { db, run, get, all } = require('./db');

const PUBLIC_DIR = path.join(__dirname, 'publications');
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const app = express();
app.use(helmet());
app.use(bodyParser.json());

// Morgan: фильтруем header Authorization (в логах не должно быть токена)
morgan.token('filtered-authorization', (req) => {
    const a = req.get('authorization') || '';
    if (!a) return '';
    return '[REDACTED]';
});
app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" :filtered-authorization'));

// Multer setup: сохраняем файл временно и потом перемещаем под именем file_id.pdf
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') return cb(null, true);
        cb(new Error('Only PDF files are allowed'));
    }
});

// Запись лога в БД
async function logAction(action_type, req, file_id = null) {
    const ip = req.ip || req.connection.remoteAddress || '';
    const ua = req.get('user-agent') || '';
    const ts = (new Date()).toISOString();
    await run(`INSERT INTO logs (action_type, ip, user_agent, file_id, ts) VALUES (?, ?, ?, ?, ?)`,
        [action_type, ip, ua, file_id, ts]);
}

// Endpoint: отправка файла из 1С на originally checker
// Ожидаемые поля в form-data:
//  Required:
//   - file (pdf)
//   - file_id (text)
//   - document_id (text)
//  Optionally:
//   - mime_type
app.post('/api/upload', authMiddleware, upload.single('file'), async (req, res) => {
    try {
        const file = req.file;
        const { file_id, document_id, mime_type } = req.body;

        if (!file_id || !document_id) {
            return res.status(400).json({ error: 'file_id and document_id are required' });
        }
        if (!file) {
            return res.status(400).json({ error: 'file is required (multipart/form-data)' });
        }

        const storedFilename = `${file_id}.pdf`;
        const storedPath = path.join(PUBLIC_DIR, storedFilename);
        const now = (new Date()).toISOString();

        // 1) Если в БД уже есть запись с этим file_id
        const existingByFileId = await get(`SELECT * FROM publications WHERE file_id = ?`, [file_id]);

        if (existingByFileId) {
            // перезаписываем файл на диск

            const isActual = await get(`SELECT * FROM publications WHERE file_type = 'actual' AND file_id = ?`, [file_id]);

            // Если файл уже есть в базе,
            if (isActual) {
                // файл актуальный, значит он pending, значит обновляем статус на fullfiled
                await run(`UPDATE publications SET date_of_creation = ?, status = ?, mime_type = ?, file_type = ? WHERE file_id = ?`,
                    [now, 'fulfilled', mime_type || 'pdf', 'actual', file_id]);
            } else {
                // файл не актуальный, значит он deleted, значит помечаем actual файл как deleted, новый как actual и pending
                await run(`UPDATE publications SET file_type = 'deleted' WHERE document_id = ? AND file_type = 'actual'`, [document_id]);

                await run(`UPDATE publications SET date_of_creation = ?, status = ?, mime_type = ?, file_type = ? WHERE file_id = ?`,
                    [now, 'pending', mime_type || 'pdf', 'actual', file_id]);
            }

            await fs.promises.writeFile(storedPath, file.buffer);


            await logAction('upload', req, file_id);
            // возвращаем ссылку, которая не меняется (file_id в URL)
            const link = `${req.protocol}://${req.get('host')}/publications/${encodeURIComponent(file_id)}`;
            return res.json({ message: 'file overwritten', file_id, link });
        }

        // 2) Иначе — если есть запись с таким document_id и file_type == 'actual' (т.е. старая версия с другим file_id)
        const existingByDoc = await get(`SELECT * FROM publications WHERE document_id = ? AND file_type = 'actual'`, [document_id]);

        if (existingByDoc) {
            // помечаем старые записи как deleted
            await run(`UPDATE publications SET file_type = 'deleted' WHERE document_id = ? AND file_type = 'actual'`, [document_id]);

            // удаляем физический файл старого file_id если существует
            const oldPath = path.join(PUBLIC_DIR, `${existingByDoc.file_id}.pdf`);
            if (fs.existsSync(oldPath)) {
                try { await fs.promises.unlink(oldPath); } catch (e) { /* ignore */ }
            }

            await fs.promises.writeFile(storedPath, file.buffer);
            await run(`INSERT OR REPLACE INTO publications (file_id, document_id, file_type, date_of_creation, status, mime_type) VALUES (?, ?, ?, ?, ?, ?)`,
                [file_id, document_id, 'actual', now, 'pending', mime_type || 'pdf']);

            await logAction('upload', req, file_id);
            const link = `${req.protocol}://${req.get('host')}/publications/${encodeURIComponent(file_id)}`;
            return res.json({ message: 'replaced old file (by document_id) with new file_id (pending QR)', file_id, link });
        }

        // 3) Ничего не найдено — это первая публикация для данного !document_id и file_id.
        // Сохраняем файл и помечаем status = pending (т.к. ожидаем возвращённый PDF с QR)
        await fs.promises.writeFile(storedPath, file.buffer);
        await run(`INSERT INTO publications (file_id, document_id, file_type, date_of_creation, status, mime_type) VALUES (?, ?, ?, ?, ?, ?)`,
            [file_id, document_id, 'actual', now, 'pending', mime_type || 'pdf']);

        await logAction('upload', req, file_id);
        const link = `${req.protocol}://${req.get('host')}/publications/${encodeURIComponent(file_id)}`;

        return res.json({ message: 'file saved (pending QR)', file_id, link });

    } catch (err) {
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
        const rec = await get(`SELECT * FROM publications WHERE file_id = ?`, [file_id]);
        if (!rec) {
            return res.status(404).send('Printable form not found');
        }
        if (rec.file_type !== 'actual') {
            // История — файл есть, но отмечен как deleted
            return res.status(410).send('The printed form is not relevant');
        }
        const filePath = path.join(PUBLIC_DIR, `${file_id}.pdf`);
        if (!fs.existsSync(filePath)) {
            // Файл отсутствует физически — пометим deleted и ответим 410
            await run(`UPDATE publications SET file_type = 'deleted' WHERE file_id = ?`, [file_id]);
            return res.status(410).send('The printed form is not relevant');
        }
        // Логируем просмотр
        await run(`INSERT INTO logs (action_type, ip, user_agent, file_id, ts) VALUES (?, ?, ?, ?, ?)`,
            ['view', req.ip || '', req.get('user-agent') || '', file_id, (new Date()).toISOString()]);

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
    const rec = await get(`SELECT * FROM publications WHERE file_id = ?`, [file_id]);
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