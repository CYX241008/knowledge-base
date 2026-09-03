# Phase 9 预发布与恢复手册

## 1. 范围与边界

本阶段将 PostgreSQL 和 MinIO 视为事实源，将 Elasticsearch 视为可重建投影，将 Redis 视为队列、限流和短期状态。仓库不会保存真实 JWT、模型密钥、数据库密码或备份文件。

生产多副本必须设置 `MODEL_RATE_LIMIT_BACKEND=redis`。Redis Lua 脚本原子检查并预留 RPM、全局 TPM、租户 TPM、用户 TPM 和 operation-model TPM；调用成功后按实际 usage 结算差额，失败且无 usage 时保留预留量直到窗口过期。Redis 同时协调 `closed/open/half-open` 熔断状态，API 和 Worker 副本共享配额与探针名额。`MODEL_RATE_LIMIT_FAIL_OPEN=false` 是默认生产策略；只有在业务明确接受 Redis 故障期间退回进程内配额与熔断状态时才允许打开。

## 2. 预发布配置

身份配置：

```dotenv
NODE_ENV=production
AUTH_MODE=jwt
AUTH_JWT_JWKS_URL=https://idp.example/.well-known/jwks.json
AUTH_JWT_ISSUER=https://idp.example/
AUTH_JWT_AUDIENCE=knowledge-base-api
AUTH_JWT_ALGORITHMS=RS256
AUTH_JWT_TENANT_CLAIM=tenant_id
AUTH_JWT_PRINCIPALS_CLAIM=principal_ids
```

模型与全局配额：

```dotenv
MODEL_PROVIDER=openai-compatible
MODEL_BASE_URL=https://model-gateway.example/v1
MODEL_API_KEY=<secret-manager-reference>
EMBEDDING_MODEL=<384-dimension-model>
CHAT_MODEL=<chat-model>
MODEL_VALIDATE_ON_STARTUP=true
MODEL_RATE_LIMIT_BACKEND=redis
MODEL_REQUESTS_PER_MINUTE=600
MODEL_GLOBAL_TOKENS_PER_MINUTE=1000000
MODEL_TENANT_TOKENS_PER_MINUTE=200000
MODEL_USER_TOKENS_PER_MINUTE=50000
MODEL_EMBEDDING_TOKENS_PER_MINUTE=500000
MODEL_CHAT_TOKENS_PER_MINUTE=300000
MODEL_RERANK_TOKENS_PER_MINUTE=300000
CHAT_MAX_OUTPUT_TOKENS=1500
MODEL_RATE_LIMIT_NAMESPACE=knowledge-base-staging
MODEL_RATE_LIMIT_FAIL_OPEN=false
MODEL_CIRCUIT_FAILURE_THRESHOLD=5
MODEL_CIRCUIT_RESET_MS=30000
MODEL_CIRCUIT_HALF_OPEN_MAX_REQUESTS=1
MODEL_CIRCUIT_HALF_OPEN_SUCCESS_THRESHOLD=2
MODEL_CIRCUIT_HALF_OPEN_PROBE_TIMEOUT_MS=90000
REDIS_URL=rediss://<managed-redis-endpoint>
```

启动时会验证数据库 `vector(384)`、Embedding 输出维度、Chat 流式输出、Reranker 响应以及模型协调 Redis。任一探针失败时，生产实例不能通过健康检查。

## 3. IdP 与模型验收

在受控终端中临时注入 token，不写入 `.env`：

```bash
STAGING_API_BASE_URL=https://kb-staging.example/api \
STAGING_AUTH_TOKEN='<primary-token>' \
STAGING_EXPECTED_TENANT_ID='<tenant-uuid>' \
STAGING_EXPECTED_USER_ID='<user-uuid>' \
STAGING_EXPECTED_PRINCIPALS='role:reader,department:engineering' \
STAGING_EXPECTED_MODEL_OPERATIONS='embedding,chat,rerank' \
pnpm verify:staging
```

可选变量：

- `STAGING_ROLE_CHANGED_AUTH_TOKEN` 和 `STAGING_CHANGED_EXPECTED_PRINCIPALS`：验证新 token 已反映角色变更。
- `STAGING_REVOKED_AUTH_TOKEN`：验证 IdP/API 对该 token 返回 401。
- `STAGING_CROSS_TENANT_TOKEN` 和 `STAGING_FORBIDDEN_DOCUMENT_ID`：验证跨租户读取返回 403 或 404。

脚本只输出身份映射摘要和模型名称，不输出任何 token。

## 4. 备份

本地或单机演练：

```bash
pnpm ops:backup
```

输出目录默认是 `backups/<UTC timestamp>`，包含：

- `postgres.dump`：PostgreSQL custom-format dump。
- `minio/`：原始文件、Markdown 和文档资产镜像。
- `tenants.txt`：需要重建搜索投影的租户。
- `manifest.json` 与 `SHA256SUMS`：格式、数量与完整性校验。

备份目录包含明文业务数据，必须写入加密卷或由备份平台进行服务端加密。生产环境优先使用托管 PostgreSQL/对象存储的时间点恢复和版本化能力；脚本用于开发、单机部署和恢复演练。

## 5. 恢复顺序

1. 停止 API 和 Worker 写入。
2. 启动 PostgreSQL、MinIO、Redis 和 Elasticsearch。
3. 校验并恢复 PostgreSQL 与 MinIO。
4. 执行 Redis/BullMQ 临时状态归并，将未完成任务重新置入 Outbox。
5. 对 `tenants.txt` 中每个租户重建 pgvector/Elasticsearch 投影。
6. 启动 API/Worker，验证健康检查、文档读取、检索和 RAG 固定评测集。

```bash
RESTORE_CONFIRM=knowledge-base pnpm ops:restore -- backups/<timestamp>

# 或在恢复后立即重建搜索投影
RESTORE_CONFIRM=knowledge-base RESTORE_REBUILD_SEARCH=true \
pnpm ops:restore -- backups/<timestamp>
```

隔离恢复演练不会读取或修改现有 Compose 数据卷：

```bash
DRILL_CONFIRM=knowledge-base pnpm drill:restore
```

## 6. 故障演练

依赖中断脚本会先确认 API 健康，停止一个依赖，等待健康检查返回 503，再恢复依赖并等待 200。退出信号也会触发恢复。

```bash
DRILL_CONFIRM=knowledge-base pnpm drill:dependency -- redis
DRILL_CONFIRM=knowledge-base pnpm drill:dependency -- elasticsearch
DRILL_CONFIRM=knowledge-base pnpm drill:dependency -- postgres
DRILL_CONFIRM=knowledge-base pnpm drill:dependency -- minio
```

Worker 演练：停止全部 Worker，上传测试文档并确认任务保持 `queued`，恢复一个 Worker 后确认任务完成且不产生重复版本或分片。

模型演练：在预发布模型网关或网络代理上依次注入 429、503、超时和流式中断，确认指标出现重试、熔断、取消与首 token 延迟。恢复服务后等待熔断窗口结束，同时发起多路请求，确认只有 `MODEL_CIRCUIT_HALF_OPEN_MAX_REQUESTS` 个探针进入下游；探针连续成功达到 `MODEL_CIRCUIT_HALF_OPEN_SUCCESS_THRESHOLD` 后，再执行 `pnpm verify:staging`。探针失败时应立即重新进入 open 窗口；探针实例异常退出时，Redis 名额应在 `MODEL_CIRCUIT_HALF_OPEN_PROBE_TIMEOUT_MS` 后可重新获取。不要通过提交错误密钥来做演练。

## 7. 验收记录

每次演练记录时间、环境、负责人、RPO/RTO、失败窗口、恢复步骤、数据校验结果和遗留问题。至少保留以下证据：

- `verify:staging` 脱敏输出。
- 备份 manifest 与 SHA-256 校验结果。
- 恢复前后固定文档和固定问题的结果。
- `/api/metrics/models` 中的限流、重试、熔断、取消和延迟指标。
- Worker/依赖中断期间的任务状态变化。
