module.exports = (req, res, next) => {
    const auth = req.get('authorization') || '';

    if (!auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = auth.slice(7).trim();
    const expected = process.env.AUTH_TOKEN

    if (!token || token !== expected) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    next();
};
