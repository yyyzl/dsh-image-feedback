# 申请社区插件市场收录

本文面向维护者，依据 2026-10-23 核对的市场规则编写。**已获作者授权，向开放插件市场提交 [收录申请 #53](https://github.com/polang233/dsh-plugin-index/issues/53)；当前为 OPEN，等待维护者审核，尚未确认收录。** 其他市场的 Issue/PR 或索引源配置变更仍需另行确认。

本项目采用 **GitHub 公开源码 + GitHub Release 预构建包**，不发布 npm。公开仓库为 [yyyzl/dsh-image-feedback](https://github.com/yyyzl/dsh-image-feedback)，包名为 `@yyyzl/dsh-image-feedback`，版本为 `0.1.0`。[包清单](../package.json)中的 `private: true` 是防止误发 npm 的保护，不妨碍公开源码或通过 Git/Release 安装，也不代表已取得同名 npm scope。

仓库已设置 `dsh-plugin`、`deepseek-harness`、`image-annotation`、`feedback` topics。这只提供发现线索或候选入口，不代表市场接受收录；除上述申请外，尚未向其他市场提交 Issue/PR。

[v0.1.0 Release](https://github.com/yyyzl/dsh-image-feedback/releases/tag/v0.1.0) 已公开发布，安装包已匿名下载并核对 SHA-256。该版本固定提交为 `2b2328c336215d454a7f3c84426ff0688e1e7926`；[Node.js 22 / 24 CI](https://github.com/yyyzl/dsh-image-feedback/actions/runs/39844975332) 均通过。以下流程用于复核或准备后续版本。

## 先完成可安装的公开发布

在投稿前确认：

- 公开仓库根目录包含可安装的完整插件：包清单、`dsh.bundle.patch` 指向的补丁、Host/Client 入口及全部构建产物；只声明 `dsh.client` 不够。
- 包名、补丁中的模块名、版本一致；保留现有 `engines.dsh: ">=0.2.1-rc.2 <0.3.0"`。填写实际测试版本，不把声明范围当作全部版本都已测试的证明。
- 公开源码、[MIT 许可证](../LICENSE)、说明文档、作者/仓库元数据、可再分发的图标齐全；检查实际打包内容，而不只检查本机链接安装。
- 创建 `v0.1.0` 标签并发布预构建包，核对下载地址、文件名和校验值。本文约定资产名为 `yyyzl-dsh-image-feedback-0.1.0.tgz`；**下方 URL 仅在同名资产确实上传后才可用于投稿**：

```text
https://github.com/yyyzl/dsh-image-feedback/releases/download/v0.1.0/yyyzl-dsh-image-feedback-0.1.0.tgz
```

该 URL 是普通 Plugin Manager 可接受的 tarball 安装来源，不需要 npm 发布。不要把它写成 npm 包名安装命令。安装属于单独操作，不应为投稿而替换当前已安装的本地插件。[官方安装说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)

标签创建后，在本仓库根目录获取固定提交：

```powershell
git rev-parse v0.1.0
git rev-parse 'v0.1.0^{commit}'
git show -s --format=%ct 'v0.1.0^{commit}'
```

第二条输出才是用于投稿的完整提交 SHA；附注标签的第一条输出可能是标签对象，而不是提交。第三条是该提交的提交者时间，单位为 Unix 秒。标签尚未创建时不要运行或虚构结果。

## 首选：开放插件市场 dshopen.org

- 维护仓库：[polang233/dsh-plugin-index](https://github.com/polang233/dsh-plugin-index)
- 索引地址：[https://dshopen.org/index.json](https://dshopen.org/index.json)
- 申请入口：[插件收录 Issue](https://github.com/polang233/dsh-plugin-index/issues/new?template=plugin-add.yml)
- 依据：[贡献指南](https://github.com/polang233/dsh-plugin-index/blob/main/.github/CONTRIBUTING.md)、[Issue 表单](https://github.com/polang233/dsh-plugin-index/blob/main/.github/ISSUE_TEMPLATE/plugin-add.yml)

一般规则偏好公开 npm 版本，但贡献指南明确允许：**未发布 npm 的插件，经维护者确认，可按固定 GitHub 提交收录。** 仓库根目录必须包含完整可安装插件、包清单、补丁和构建产物；维护者核查归档并记录哈希。这是本项目无需 npm、进入其 Discover 索引的优先申请路线，不是自动收录承诺。

表单标题以 `[plugin-add]` 开头，字段如下：

| 字段 | 必填 | 本项目填写内容 |
| --- | --- | --- |
| 插件地址 / Plugin link | 是 | `https://github.com/yyyzl/dsh-image-feedback` |
| 简短说明 / Summary | 是 | 在 DeepSeek Harness 中标注图片、调整区域和标记位置，并独立发送图片反馈。 |
| 补充信息 / Additional details | 否；本项目的 Git 来源材料放在这里 | 说明未发布 npm；填写包名、版本 `0.1.0`、上述命令取得的完整提交 SHA、已验证的 Release 下载地址、MIT 许可证、实际测试版本及截图。 |

固定 Git 来源的仓库、版本和完整 SHA 是贡献指南要求的补充材料，不能因表单第三项标为可选就省略。可附发布包 SHA-256，方便维护者核验，但表单没有强制作者填写的 `integrity` 字段；维护者仍会自行核查。后续固定提交升级，在原 Issue 回复新版本及完整 SHA，等待重新核查。

## 同时覆盖 dshmarket.com：向 awesome 目录提 PR

[dsh-market/dsh-market](https://github.com/dsh-market/dsh-market#submit-your-plugin) 是市场应用；**不要向应用仓库提交插件条目**。目录由 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 维护。

按[贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)，在目录仓库新增一个 `data/plugins/yyyzl__dsh-image-feedback.yml`，不要手改自动生成的 README。以下是公开发布完成后可采用的条目内容：

```yaml
url: https://github.com/yyyzl/dsh-image-feedback
name: yyyzl/dsh-image-feedback
category: vision
description:
  en: Annotate images, reposition regions and pins, and send independent image feedback in DeepSeek Harness.
  zh: 在 DeepSeek Harness 中标注图片、调整区域和标记位置，并独立发送图片反馈。
tarball: https://github.com/yyyzl/dsh-image-feedback/releases/download/v0.1.0/yyyzl-dsh-image-feedback-0.1.0.tgz
```

提交条件：仓库创建已满 **1 天**、真实可用的 `dsh.bundle`、持续维护、`dsh-plugin` topic、准确而不夸大的功能说明。每个 PR 最多新增 3 条，本项目只需 1 条。维护者还会读源码；CI 通过不等于接受收录。

本仓库创建时间为 `2026-10-22T19:49:45Z`；若该规则保持不变，最早在 **2026-10-24 03:49:45（Asia/Shanghai，UTC+8）** 满足仓库年龄门槛。届时仍需作者确认投稿，并满足其他条件；无需为等待门槛而延迟公开发布。

**npm 不是目录或市场应用收录的必要条件。** GitHub Release 上的 HTTPS `.tgz` 可通过 `tarball` 提供；若仓库无法直接从源码安装，该字段是必需的。不要增加 `npm:` 字段。可选 `icon` 只接受 GitHub 托管的 PNG/JPEG/WebP 位图，不接受 SVG。

但其[目录说明](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin#readme)明确指出：当前导出的官方格式 Discover 索引只覆盖“已发布 npm 且版本已知”的条目。**GitHub-only PR 被合并，不等于会进入该 Discover 索引。** 网站和市场应用中的 GitHub 安装条目仍可使用。

该目录公布的 Discover 地址是 [jsDelivr 索引](https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json)，另有 [awesome 站点镜像](https://awesome-dsh-plugin.com/index.json)和 [dshmarket.com 镜像](https://dshmarket.com/index.json)；上游提示镜像在部分网络可能超过 DSH 的 15 秒默认超时。

## 另一个独立市场：dsh.market

[dsh.market](https://dsh.market/) 对应 [2BingLing/dsh-market](https://github.com/2BingLing/dsh-market)，不是上一节的市场。

依据[贡献指南](https://github.com/2BingLing/dsh-market/blob/master/CONTRIBUTING.md)，可为仓库添加 `dsh-plugin` topic，或使用[提交插件 Issue](https://github.com/2BingLing/dsh-market/issues/new?template=submit_plugin.md)：填写仓库地址、类型 `cordis-plugin`、一句话简介；可补充作者自述、截图和配置需求。

Topic 或 Issue 只让仓库进入候选池，仍需通过插件特征检测；非 fork、非归档且具备真实 DSH 插件内容才符合其规则。其文档未要求 npm 发布，也没有保证立即收录。本次未核实到它的官方格式 Discover 索引 URL，不要猜测地址，也不要把它自己的目录数据当作 DSH 索引。

## 区分安装来源、目录与 Discover 索引

[DSH 官方指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.zh.md)和[可执行校验器](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/plugin-market-index/src/index.ts)规定，格式 `1` 的索引版本来源只有 `npm` 或 `git`；Git 来源必须固定完整 40 位小写十六进制提交 SHA。**没有 `tarball` 来源类型**，普通安装能用 `.tgz` 不代表索引能直接列 `.tgz`。

GitHub-only 插件可以由支持 Git 来源的市场列入索引，不必发布 npm；但上传仓库或 Release 本身不会生成索引。本项目不自建索引，也不依赖当前校验器未要求的 `dist-tags`。

索引是第三方声明，不是安全认证。本次调研的 profile 索引列表为空，本文没有添加任何源。使用者应自行判断信任关系，再在 **插件 → 实验性插件 → 自定义插件市场 → 发现 → 添加索引源** 中手动添加；作者不能因发布或收录而替用户修改配置。

以上链接和流程来自已读取的上游仓库文档；市场索引端点的实时可用性未在本次环境中验证。正式投稿前重读对应贡献指南并确认公开发布资产可下载。
