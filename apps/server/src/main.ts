// Server entry. `--mock` serves scripted protocol-valid data (TEAM_SPLIT.md §3).
const mock = process.argv.includes('--mock');
console.log(`saltmarket server: ${mock ? 'mock' : 'live'} mode not implemented yet`);
