# 权限设计

更新时间：2026-09-03

## 1. 权限边界

系统采用租户隔离、租户级能力和资源级 ACL 三层模型：

1. `tenant_id` 隔离租户数据。
2. `access_role -> role_permission` 授予租户级管理能力。
3. `resource_acl` 授予具体文档、空间和文件夹的资源权限。

权限字典通过 `access_permission.scope` 明确区分：

| 作用域     | 权限                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------- |
| `tenant`   | `access.manage`、`system.manage`、`knowledge.manage`、`documents.create`、`documents.review`    |
| `resource` | `documents.read`、`documents.update`、`documents.delete`、`documents.manage`、`documents.share` |

角色只能绑定 `tenant` 权限。`resource` 权限必须通过 `resource_acl` 授予用户、角色、部门或整个租户。

## 2. 身份与主体

认证支持 `demo` 和 JWT 两种模式。JWT 校验签名、issuer、audience 和有效期。

认证后形成两组数据：

- `permissionKeys`：租户级能力。
- `principalIds`：ACL 主体，格式为 `tenant:<uuid>`、`user:<uuid>`、
  `department:<uuid>` 或 `role:<uuid>`。

每次请求都会从 PostgreSQL 展开用户当前角色、部门和角色权限。停用的租户或用户不能继续访问。

## 3. 文档权限

| 操作                                     | 权限要求                                     |
| ---------------------------------------- | -------------------------------------------- |
| 新建文档                                 | `documents.create` 租户权限                  |
| 查看文档、Markdown、搜索和问答召回       | 有效 `documents.read` ACL                    |
| 创建版本、完成上传、移动和修改标签       | `documents.update` 或 `documents.manage` ACL |
| 删除文档                                 | `documents.delete` 或 `documents.manage` ACL |
| 发布、提交审核、撤回审核、任务重试或取消 | `documents.manage` ACL                       |
| 修改文档 ACL                             | `documents.share` 或 `documents.manage` ACL  |
| 审核、批准或驳回                         | `documents.review` 租户权限                  |

文档创建者具有资源所有者权限；`access.manage` 可以执行租户内全部管理操作。

## 4. ACL 继承

文档有效读取主体是以下授权的并集：

```text
文档直接 ACL
+ 当前文件夹 ACL
+ 祖先文件夹 ACL
+ 所属空间 ACL
```

系统目前是纯允许模型，没有显式拒绝规则。文档 ACL API 分别返回：

- `directGrants`：文档自身配置的权限。
- `effectivePrincipalIds`：展开继承后可读取文档的主体。

更新文档 ACL 只替换 `directGrants`，不会把继承权限固化成文档直接授权。

## 5. 检索权限

有效读取主体会物化到：

1. `document_effective_principal`
2. `document.access_principal_ids`
3. `document_chunk.principal_ids`
4. Elasticsearch `principal_ids`

ACL 变更在 PostgreSQL 事务内更新有效权限和向量分片，并通过 Outbox
异步刷新 Elasticsearch。向量召回、关键词召回和候选水合阶段都会校验
`tenant_id`、有效主体和已发布版本。

## 6. 前端

Web 从 `/api/auth/me` 获取 `permissionKeys`：

- 无管理权限时隐藏系统设置和访问控制入口。
- `knowledge.manage` 用户可以维护知识组织，但不需要访问完整角色配置。
- 文档按钮根据服务端返回的 `allowedPermissions` 启用。
- 文档 ACL 编辑器分别展示直接授权和继承授权。
