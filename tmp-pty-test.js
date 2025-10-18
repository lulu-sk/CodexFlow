const pty = require('@lydell/node-pty');
const shell = process.env.SHELL_FOR_TEST || 'powershell.exe';
const proc = pty.spawn(shell, ['-NoLogo'], { name: 'xterm-256color', cols: 120, rows: 30 });
proc.onData((data) => {
  const bytes = Array.from(Buffer.from(data, 'utf8')).map((byte) => byte.toString(16).padStart(2,'0')).join(' ');
  console.log('DATA:', JSON.stringify(data));
  console.log('HEX:', bytes);
});
setTimeout(() => {
  const cmd = '\r\n$esc = [char]27\r\n$bel = [char]7\r\nWrite-Host ($esc + "]9;agent-turn-complete: demo" + $bel)\r\nStart-Sleep -Milliseconds 200\r\nexit\r\n';
  console.log('SENDING CMD');
  proc.write(cmd);
}, 500);
setTimeout(() => { try { proc.kill(); } catch {} }, 4000);
