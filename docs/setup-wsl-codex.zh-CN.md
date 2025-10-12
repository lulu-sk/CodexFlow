# 在 Windows 安装 WSL(Ubuntu)并在 WSL 安装 Codex CLI

## 1️⃣ 安装 WSL(Ubuntu)

在 **管理员 PowerShell / Windows Terminal** 执行：

```powershell
wsl --install -d Ubuntu
```

安装结束后会 **自动启动 Ubuntu 应用**,按提示 **设置 Linux 用户名/密码**。
**设置完成后：关闭 Ubuntu/WSL 窗口。**
(若未自动打开,可从开始菜单手动启动 **Ubuntu** 完成首次设置后再关闭。)
📖 [Microsoft Learn][1]

---

## 2️⃣ 网络代理环境(如果你不使用网络代理,则跳过此步骤)

> 若你在 Windows 里用 `127.0.0.1/localhost` 代理,而 WSL 处于 **NAT**,WSL 看不到该回环地址。启用 **mirrored** 后可直接互通 `localhost`,也能自动继承 Windows 代理；否则在 NAT 下需走 **网关 IP**。
> 📖 [Microsoft Learn][2]

首先,在代理软件中找到设置,**打开“局域网连接”选项并启用代理**,然后在以下 A/B 两个方案中任选其一进行操作：

---

### ✅ 方案 A【推荐】：镜像网络(mirrored)——自动继承 Windows 代理

1. 在 **PowerShell** 打开：

```powershell
notepad $env:UserProfile\.wslconfig
```

2. 写入并保存：

```
[wsl2]
networkingMode=mirrored
autoProxy=true
dnsTunneling=true
```

> * `mirrored` 让 Windows 与 WSL 互通 `127.0.0.1`
> * `autoProxy=true` 让 WSL 自动套用 Windows 的 HTTP 代理
> * `dnsTunneling=true` 改善某些网络/VPN 的 DNS 兼容性(新版本 WSL/Win11 支持)
>   📖 [Microsoft Learn][2]

3. **重启 WSL：**

```powershell
wsl --shutdown
```

然后从开始菜单打开 **Ubuntu**(或终端执行 `wsl`)。

4. **在 Ubuntu 里验证网络(仅两步,无 curl/openssl)：**

```bash
# 是否继承到代理变量(若使用代理)
printenv | grep -i proxy

# DNS 可解析(应返回 www.google.com 的地址之一)
getent hosts www.google.com | head -n1
```

> `getent … hosts` 使用 NSS 进行主机名解析,是标准做法。
> 📖 [man7.org][3]
> 如遇企业自签 CA,见文末“证书”小贴士。

---

### ⚙️ 方案 B：继续使用 NAT,但通过 **Allow LAN + 网关 IP** 走代理

1. 在 Windows 代理工具(Clash、v2rayN 等)开启 **Allow LAN / 允许局域网连接**,记下端口(如 `7890`)。

2. 在 Ubuntu 获取 **Windows 在 WSL 内的网关 IP**(不是 `127.0.0.1`)：

```bash
ip route | awk '/default/ {print $3}'
# 或
grep -m1 nameserver /etc/resolv.conf | awk '{print $2}'
```

3. 在 WSL 设置代理变量(按实际端口修改；SOCKS5 用 `socks5://` 并设 `ALL_PROXY`)：

```bash
PROXY_PORT=7890
WINIP=$(ip route | awk '/default/ {print $3}')
export http_proxy="http://$WINIP:$PROXY_PORT"
export https_proxy="$http_proxy"
export ALL_PROXY="$http_proxy"
export no_proxy="localhost,127.0.0.1,::1,.local,.lan"
```

4. **验证(仍然只做两步)：**

```bash
printenv | grep -i proxy
getent hosts www.google.com | head -n1
```

> * 在 **mirrored** 下可直接互通 `localhost`；在 **NAT** 下需用 **网关 IP**。
> * 若只想消除“检测到 localhost 代理配置,但未镜像到 WSL”的提示且不在 WSL 用代理：
>   把 `.wslconfig` 改为
>
>   ```
>   networkingMode=nat
>   autoProxy=false
>   ```
>
>   再执行 `wsl --shutdown`。
>   📖 [Microsoft Learn][2]

---

## 3️⃣ 一条命令装好：基础工具 + Node.js 22 + Codex CLI(root 非交互)

> 以下命令从 **Windows**  PowerShell中执行,使用 **root** 在 Ubuntu 内一次性完成安装；装完再打开 WSL 即可。
> `wsl -d/--distribution` 与 `-u/--user` 为官方支持参数。
> 📖 [Microsoft Learn][4]

打开 **PowerShell** 粘贴以下内容并回车

```powershell
wsl -d Ubuntu -u root -- bash -lc `
'set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates git curl
# 安装 Node.js 22 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
# 安装 Codex CLI
npm i -g @openai/codex'
```

> Node.js 22 的 NodeSource 官方安装指引：`setup_22.x` → `apt-get install nodejs`。
> 📖 [deb.nodesource.com][5]

安装完成后,打开开始菜单的 **Ubuntu**(以你的普通用户登录),运行：

```bash
codex
```

首次运行会出现登录流程,选择 **“Sign in with ChatGPT”** 即可(也支持 API Key)。
官方页面与 npm 说明如下：
📖 [OpenAI Developers][6]

---

## 4️⃣(可选)管理多发行版 / 清理会话

```powershell
# 查看发行版
wsl -l -v

# 设默认(如有多个)
wsl --set-default Ubuntu

# 关闭所有 WSL 实例
wsl --shutdown
```

> 更多基础命令(例如 `--distribution` / `--user` 的用法)见微软文档。
> 📖 [Microsoft Learn][4]

---

## 🧩 证书与企业网络小贴士(按需,非必要步骤)

* **导入企业/自签 CA**：
将 PEM 证书(`.crt`,含 `-----BEGIN CERTIFICATE-----`)放到
`/usr/local/share/ca-certificates/你的证书.crt`,然后执行：

```bash
sudo update-ca-certificates
```

(若无 sudo,可继续用上面的 root 一条命令思路执行。)

* Ubuntu/WSL 通用流程。

> 遇到部分 VPN/网络兼容问题时,可根据微软故障排查建议,视情况调整 `dnsTunneling` 或临时改回 NAT。
> 📖 [Microsoft Learn][7]

---

[1]: https://learn.microsoft.com/en-us/windows/wsl/install?utm_source=chatgpt.com "How to install Linux on Windows with WSL"
[2]: https://learn.microsoft.com/en-us/windows/wsl/networking?utm_source=chatgpt.com "Accessing network applications with WSL"
[3]: https://man7.org/linux/man-pages/man1/getent.1.html?utm_source=chatgpt.com "getent(1) - Linux manual page"
[4]: https://learn.microsoft.com/en-us/windows/wsl/basic-commands?utm_source=chatgpt.com "Basic commands for WSL"
[5]: https://deb.nodesource.com/?utm_source=chatgpt.com "Nodesource Node.js DEB"
[6]: https://developers.openai.com/codex/cli/?utm_source=chatgpt.com "Codex CLI"
[7]: https://learn.microsoft.com/en-us/windows/wsl/troubleshooting?utm_source=chatgpt.com "Troubleshooting Windows Subsystem for Linux"
