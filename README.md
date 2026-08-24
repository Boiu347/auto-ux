# auto-ux

自动化调研进度网站。当前仓库包含 NX Server 可部署的最小 Web 服务基线，后续业务页面可以在不改变发布合同的前提下继续开发。

## 本地运行

```bash
python3 app.py
curl http://127.0.0.1:8080/health
```

## 测试

```bash
python3 -m unittest discover -s tests
```

## 发布

- Merge Request pipeline 自动发布固定 Preview。
- 合并到 `main` 后自动发布 Production。
- Preview：`https://wowdata.guanghexinzhi.cn/_preview/auto-ux/`
- Production：`https://wowdata.guanghexinzhi.cn/auto-ux/`

部署密钥由 NX 平台按项目绑定，禁止写入仓库。
