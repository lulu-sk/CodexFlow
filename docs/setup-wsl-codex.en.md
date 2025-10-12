# Install WSL (Ubuntu) on Windows and set up Codex CLI inside WSL

## 1️⃣ Install WSL (Ubuntu)

Run the following in **elevated PowerShell / Windows Terminal**:

```powershell
wsl --install -d Ubuntu
```

After installation WSL auto-launches the **Ubuntu** app. Finish the initial username/password setup, then close the Ubuntu window. (If it does not launch, open **Ubuntu** from the Start menu, finish the setup, then close it.)
📖 [Microsoft Learn][1]

---

## 2️⃣ Network proxy scenarios (skip if you don't use a proxy)

> If your Windows proxy listens on `127.0.0.1/localhost` while WSL stays in **NAT** mode, the proxy is not reachable from WSL. Enabling **mirrored** networking keeps both sides on the same 127.0.0.1 loopback and automatically inherits the proxy variables; otherwise you must use the **gateway IP** in NAT mode.
> 📖 [Microsoft Learn][2]

First, enable the **Allow LAN / proxy sharing** option inside your proxy software. Then pick either option A or B below.

---

### ✅ Option A (recommended): Mirrored networking — auto-inherit Windows proxy variables

1. Open **PowerShell**:

```powershell
notepad $env:UserProfile\.wslconfig
```

2. Paste the following and save:

```
[wsl2]
networkingMode=mirrored
autoProxy=true
dnsTunneling=true
```

> * `mirrored` keeps localhost reachable from both Windows and WSL.
> * `autoProxy=true` lets WSL inherit Windows HTTP(S) proxy settings.
> * `dnsTunneling=true` improves DNS compatibility for certain networks/VPNs (requires recent WSL/Windows 11 builds). 📖 [Microsoft Learn][2]

3. **Restart WSL**:

```powershell
wsl --shutdown
```

Launch **Ubuntu** from the Start menu (or run `wsl`).

4. **Verify inside Ubuntu (two quick checks; no curl/openssl needed):**

```bash
# Shows inherited proxy variables (if any)
printenv | grep -i proxy

# DNS lookup should return one of www.google.com's addresses
getent hosts www.google.com | head -n1
```

> `getent … hosts` relies on NSS and is the standard way to verify hostname resolution.
> 📖 [man7.org][3]
> Handling corporate CAs? See the “Certificates” tips at the end.

---

### ⚙️ Option B: Stay in NAT mode but point to the gateway IP via Allow LAN

1. In your Windows proxy tool (Clash, v2rayN, etc.) enable **Allow LAN / listen for LAN connections** and note the port (e.g. `7890`).

2. Inside Ubuntu obtain the **gateway IP** (Windows host as seen by WSL; not `127.0.0.1`):

```bash
ip route | awk '/default/ {print $3}'
# or
grep -m1 nameserver /etc/resolv.conf | awk '{print $2}'
```

3. Export proxy variables (adjust the port; use `socks5://` and set `ALL_PROXY` for SOCKS5):

```bash
PROXY_PORT=7890
WINIP=$(ip route | awk '/default/ {print $3}')
export http_proxy="http://$WINIP:$PROXY_PORT"
export https_proxy="$http_proxy"
export ALL_PROXY="$http_proxy"
export no_proxy="localhost,127.0.0.1,::1,.local,.lan"
```

4. **Verify (same two checks):**

```bash
printenv | grep -i proxy
getent hosts www.google.com | head -n1
```

> * With **mirrored** networking you can talk to Windows services via `localhost`; with **NAT** you must use the gateway IP.
> * If you only want to silence “localhost proxy detected but not mirrored” warnings and do not need the proxy inside WSL, set `.wslconfig` to:
>
>   ```
>   networkingMode=nat
>   autoProxy=false
>   ```
>
>   followed by `wsl --shutdown`. 📖 [Microsoft Learn][2]

---

## 3️⃣ One-liner: Base tools + Node.js 22 + Codex CLI (run as root, non-interactive)

> Run this from **Windows PowerShell**. It executes inside Ubuntu as **root**, performing all installations in a single pass. After it finishes, launch WSL again and continue with your normal user. `wsl -d/--distribution` and `-u/--user` are official parameters.
> 📖 [Microsoft Learn][4]

Launch **PowerShell**, paste, and run:

```powershell
wsl -d Ubuntu -u root -- bash -lc `
'set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates git curl
# Install Node.js 22 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
# Install Codex CLI
npm i -g @openai/codex'
```

> Node.js 22 follows NodeSource’s official guide: run `setup_22.x`, then `apt-get install nodejs`.
> 📖 [deb.nodesource.com][5]

After the script completes, open **Ubuntu** from the Start menu (logged in as your regular user) and run:

```bash
codex
```

The first run triggers the sign-in flow. Choose **“Sign in with ChatGPT”** (API keys also work). Official docs and npm information:
📖 [OpenAI Developers][6]

---

## 4️⃣ (Optional) Manage multiple distributions / reset sessions

```powershell
# List distributions
wsl -l -v

# Set the default (if you have more than one)
wsl --set-default Ubuntu

# Shut down every WSL instance
wsl --shutdown
```

> See Microsoft’s guide for more commands and distribution/user parameters.
> 📖 [Microsoft Learn][4]

---

## 🧩 Certificates & corporate network tips (optional)

* **Import corporate / self-signed CA**: Place the PEM (`.crt`, includes `-----BEGIN CERTIFICATE-----`) under `/usr/local/share/ca-certificates/your-cert.crt`, then run:

```bash
sudo update-ca-certificates
```

(No sudo? Reuse the root one-liner approach above.)

* Works for standard Ubuntu/WSL setups.

> If specific VPNs or networks misbehave, adjust `dnsTunneling` or temporarily revert to NAT according to Microsoft’s troubleshooting guidance.
> 📖 [Microsoft Learn][7]

---

[1]: https://learn.microsoft.com/en-us/windows/wsl/install?utm_source=chatgpt.com "How to install Linux on Windows with WSL"
[2]: https://learn.microsoft.com/en-us/windows/wsl/networking?utm_source=chatgpt.com "Accessing network applications with WSL"
[3]: https://man7.org/linux/man-pages/man1/getent.1.html?utm_source=chatgpt.com "getent(1) - Linux manual page"
[4]: https://learn.microsoft.com/en-us/windows/wsl/basic-commands?utm_source=chatgpt.com "Basic commands for WSL"
[5]: https://deb.nodesource.com/?utm_source=chatgpt.com "Nodesource Node.js DEB"
[6]: https://developers.openai.com/codex/cli/?utm_source=chatgpt.com "Codex CLI"
[7]: https://learn.microsoft.com/en-us/windows/wsl/troubleshooting?utm_source=chatgpt.com "Troubleshooting Windows Subsystem for Linux"
