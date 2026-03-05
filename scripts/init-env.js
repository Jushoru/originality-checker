const { existsSync, copyFileSync } = require('fs')
const { join } = require('path')

const root = process.cwd()
const source = join(root, '.env.example')
const target = join(root, '.env')

if (existsSync(target)) {
    console.log('✅ .env уже существует, пропускаем инициализацию')
} else if (existsSync(source)) {
    copyFileSync(source, target)
    console.log('✅ .env создан на основе .env.example')
} else {
    console.warn('⚠️ .env.example не найден. Создайте .env вручную.')
    process.exit(1)
}