# WhatsApp 提醒自动发送

用 **018-320 9696 客服号** 按 Excel 名单自动逐条发送 WhatsApp，对方不需要存你的号码。
（非官方方式，基于 Baileys。号码有被 WhatsApp 限制或封号的风险，请只用客服号，不要用主号。）

## 第一次安装（Windows / Mac 都可以）
1. 安装 Node.js（LTS 版）：https://nodejs.org
2. 下载这个 repo，打开终端（Windows 用 PowerShell），进入 `whatsapp-blaster` 文件夹：
   ```
   cd whatsapp-blaster
   npm install
   ```

## 每次使用
1. 准备名单 Excel（.xlsx）或 CSV，第一行是标题，要有一栏 **电话**（或 号码 / phone / HP）。参考 `名单范例.csv`。
2. 修改 `message.txt` 信息内容，用 `{标题}` 套入资料，例如 `{名字}`、`{日期}`（要和 Excel 标题一模一样）。
3. **先预览**（不会登入、不会发送，还会算出如果用官方 API 要多少钱）：
   ```
   npm run preview 名单.xlsx
   ```
4. 正式发送：
   ```
   npm start 名单.xlsx
   ```
   第一次会出现 QR code，用 018 那部手机：WhatsApp → 已连接的设备 → 连接设备 → 扫描。
   之后登入资料存在 `auth` 文件夹，不用再扫。

## 邀请进 WhatsApp 频道 + 自动回复
1. 在 018 手机建立频道：WhatsApp → 更新 → ➕ → 新频道，复制频道链接
2. 打开 `config.json`，把链接贴进 `autoReply` → `channelLink`
3. `message.txt` 是第一条邀请信息（请对方回复 1），`reply.txt` 是自动回复内容（`{链接}` 会换成频道链接）
4. `npm start 名单.xlsx` 发完当天的邀请后，**程序会继续开着**，谁回复 1 / 要 / yes / 有兴趣，就自动发频道链接给他（每人只发一次）
5. 不想发新邀请、只想开着等回复：`npm run listen`

⚠️ 程序要开着（电脑不要关、不要睡眠）才会自动回复。关掉期间收到的回复不会补发，请自己手动回。

## 自动保护
- 每条之间随机等 20–45 秒，每 30 条休息 5–10 分钟，每天最多 10 条（在 `config.json` 修改）
- 发之前先检查对方有没有 WhatsApp，没有就跳过
- 重复号码自动跳过；所有结果记录在 `sent-log.csv`
- 中途停止（Ctrl+C）或到了每日上限，下次运行同一个名单会从没发的继续

## 减少被封的建议
- 新号码先正常用几天，第一天只发 20–30 条，慢慢增加
- 信息开头写明身份，客户比较不会按"举报"
- 不要所有人收到一模一样的内容（用 `{名字}` 等变量）
- 有客户回复就回应他们
