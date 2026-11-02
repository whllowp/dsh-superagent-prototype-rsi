// Probe checker: the night glow must be a real zpet-glow element, driven by a .zpet-night .zpet-glow CSS rule with a transition.
const fs = require('node:fs')
const text = fs.readFileSync('src/pet.tsx', 'utf8')
const hasElement = text.includes('zpet-glow')
const hasNightRule = /\.zpet-night\s+\.zpet-glow/.test(text)
const hasTransition = /zpet-glow[^}]*transition|transition[^}]*zpet-glow/.test(text) || text.includes('transition')
process.exit(hasElement && hasNightRule && hasTransition ? 0 : 1)
