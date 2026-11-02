// Probe checker: the pet must keep a line history panel (zpet-log) listing the last lines said.
const fs = require('node:fs')
const text = fs.readFileSync('src/pet.tsx', 'utf8')
const ok = text.includes('zpet-log')
process.exit(ok ? 0 : 1)
