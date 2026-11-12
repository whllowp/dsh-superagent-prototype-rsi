// Audit checker: the pet must breathe while idle (zpet-breath keyframes applied to the idle body).
const fs = require('node:fs')
const text = fs.readFileSync('src/pet.tsx', 'utf8')
const ok = text.includes('zpet-breath') && /zpet-idle[^}]*zpet-breath|zpet-breath[^}]*zpet-idle/.test(text.replace(/\n/g, ' '))
process.exit(ok ? 0 : 1)
