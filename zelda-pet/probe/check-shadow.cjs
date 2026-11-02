// Probe checker: the pet must scale a ground shadow while jumping (zpet-shadow + its keyframes).
const fs = require('node:fs')
const text = fs.readFileSync('src/pet.tsx', 'utf8')
const ok = text.includes('zpet-shadow') && text.includes('zpet-shadow-scale')
process.exit(ok ? 0 : 1)
