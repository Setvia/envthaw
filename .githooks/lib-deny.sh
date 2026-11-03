# 共用判定：哪些路径不允许进入公开仓库
# 由 pre-commit / pre-push 钩子 source，勿直接执行。

envthaw_is_sensitive() {
  p="$1"
  case "$p" in
    # 文档模板允许保留
    .env.example|.env.sample|*/.env.example|*/.env.sample) return 1 ;;
    # 后端 / 服务端代码（单独仓库维护）
    server/*|envthaw-server/*|backend/*|api-server/*|service/*) return 0 ;;
    # 运行时数据与配置
    data/*|config/*) return 0 ;;
    # 密钥 / 证书
    *.pem|*.p12|*.pfx|*.key|*.jks|*.keystore) return 0 ;;
    id_rsa|id_ed25519|keys.json|*/keys.json|*secrets*.json) return 0 ;;
    # 环境变量文件（模板已在上面放行）
    .env|*.env|*.env.*) return 0 ;;
    # 商业文档
    *.docx) return 0 ;;
  esac
  return 1
}
