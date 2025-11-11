const crypto = require('crypto');

function generateToken(length = 32) {
    return crypto.randomBytes(length).toString('hex');
}

const token = generateToken();
console.log('Сгенерированный токен:', token);
console.log('Длина токена:', token.length, 'символов');

module.exports = { generateToken };