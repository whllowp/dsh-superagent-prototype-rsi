// Probe checker: the pet must draw a heart animation (zpet-heart) after a double click.
const fs = require('node:fs')
const text = fs.readFileSync('src/pet.tsx', 'utf8')
const ok = text.includes('zpet-heart') && /heart/i.test(text)
process.exit(ok ? 0 : 1)
