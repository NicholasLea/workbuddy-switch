//! Client-scoped session group directory and explicit-member operations.
//!
//! This module is the group-management boundary used by Tauri and WebUI. It reads the
//! existing namespace stores and delegates every write to the client-specific session
//! kernels; it never resolves an operation source from a client's active login state.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use crate::modules::session::{SessionPaths, SyncSelection};
use crate::modules::session_link::{
    ContentState, LinkGroup, LinkMember, MemberState, StoreState, SyncVerdict,
};
use crate::modules::vscode_session::{
    CopyItem, SessionStoreSpec, CODEBUDDY_IDE_STORE, VSCODE_STORE,
};
use crate::modules::{
    account, codebuddy_ide_session, codebuddy_ide_session_sync, config, process, session,
    session_link, variant::WbVariant, vscode_ext, vscode_session, vscode_session_sync,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionClient {
    Workbuddy,
    CodebuddyIde,
    VscodeExt,
}

impl SessionClient {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "workbuddy" => Ok(Self::Workbuddy),
            "codebuddyIde" => Ok(Self::CodebuddyIde),
            "vscodeExt" => Ok(Self::VscodeExt),
            _ => Err("不支持的会话客户端".to_string()),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Workbuddy => "workbuddy",
            Self::CodebuddyIde => "codebuddyIde",
            Self::VscodeExt => "vscodeExt",
        }
    }

    fn store_paths(self) -> SessionPaths {
        match self {
            Self::Workbuddy => SessionPaths::for_variant(WbVariant::Cn),
            Self::CodebuddyIde => SessionPaths::for_codebuddy_ide(),
            Self::VscodeExt => SessionPaths::for_vscode_ext(),
        }
    }

    fn data_root(self) -> Option<PathBuf> {
        match self {
            Self::Workbuddy => None,
            Self::CodebuddyIde => codebuddy_ide_session::ide_data_root(),
            Self::VscodeExt => vscode_session::ext_data_root(),
        }
    }

    fn store_spec(self) -> Option<SessionStoreSpec> {
        match self {
            Self::Workbuddy => None,
            Self::CodebuddyIde => Some(CODEBUDDY_IDE_STORE),
            Self::VscodeExt => Some(VSCODE_STORE),
        }
    }

    fn validate_scope(self, scope: Option<WbVariant>) -> Result<(), String> {
        match (self, scope) {
            (Self::CodebuddyIde, Some(_)) | (Self::Workbuddy | Self::VscodeExt, None) => Ok(()),
            (Self::CodebuddyIde, None) => {
                Err("CodeBuddy IDE 请求必须指定 cn 或 ai 档位".to_string())
            }
            (Self::Workbuddy | Self::VscodeExt, Some(_)) => {
                Err("只有 CodeBuddy IDE 支持档位筛选".to_string())
            }
        }
    }
}

pub fn parse_variant_scope(raw: Option<&str>) -> Result<Option<WbVariant>, String> {
    match raw.map(str::trim) {
        None | Some("") => Ok(None),
        Some("cn") => Ok(Some(WbVariant::Cn)),
        Some("ai") => Ok(Some(WbVariant::Ai)),
        Some(_) => Err("variantScope 只支持 cn 或 ai".to_string()),
    }
}

#[derive(Debug, Clone)]
struct MemberView {
    member: LinkMember,
    account_key: String,
    account_name: String,
    title: String,
    project_label: String,
    updated_at: i64,
    content: ContentState,
    reason: String,
    version_status: &'static str,
}

/// List lightweight searchable summaries. IDE must include its mandatory variant scope.
pub fn list(client: SessionClient, scope: Option<WbVariant>) -> Result<Value, String> {
    client.validate_scope(scope)?;
    let paths = client.store_paths();
    let mut result = json!({
        "client": client.as_str(),
        "variantScope": scope.map(WbVariant::as_str),
        "storeStatus": "missing",
        "groups": [],
    });
    match session_link::load_store(&paths) {
        StoreState::Missing => {}
        StoreState::Unavailable(reason) => {
            result["storeStatus"] = json!("unavailable");
            result["storeError"] = json!(reason);
        }
        StoreState::Ready(store) => {
            result["storeStatus"] = json!("ready");
            let accounts = account::load_accounts_at(&account::accounts_file_in(&paths.store_root));
            let mut cache = HashMap::new();
            let groups = store
                .groups
                .iter()
                .filter(|group| group_is_in_scope(client, scope, group))
                .map(|group| {
                    group_payload(client, scope, &paths, group, &accounts, &mut cache, false)
                })
                .collect::<Vec<_>>();
            result["groups"] = json!(groups);
        }
    }
    Ok(result)
}

/// Load one group and all saved members, including stale/superseded entries.
pub fn detail(
    client: SessionClient,
    scope: Option<WbVariant>,
    group_id: &str,
) -> Result<Value, String> {
    client.validate_scope(scope)?;
    let paths = client.store_paths();
    let store = match session_link::load_store(&paths) {
        StoreState::Ready(store) => store,
        StoreState::Missing => return Err("会话关联组不存在".to_string()),
        StoreState::Unavailable(reason) => return Err(format!("会话关联组暂不可用：{reason}")),
    };
    let group = store
        .groups
        .iter()
        .find(|group| group.id == group_id && group_is_in_scope(client, scope, group))
        .ok_or_else(|| "会话关联组不存在或不属于当前客户端".to_string())?;
    let accounts = account::load_accounts_at(&account::accounts_file_in(&paths.store_root));
    let mut cache = HashMap::new();
    Ok(group_payload(
        client, scope, &paths, group, &accounts, &mut cache, true,
    ))
}

/// Preview one exact source/target member pair using the existing per-client preview-token kernel.
pub fn preview_pair(
    client: SessionClient,
    scope: Option<WbVariant>,
    group_id: &str,
    source_member_id: &str,
    target_member_id: &str,
) -> Result<Value, String> {
    let context = resolve_pair(client, scope, group_id, source_member_id, target_member_id)?;
    preview_resolved_pair(client, scope, &context)
}

/// Sync one explicit pair. The existing kernel revalidates the namespace/group/member/content token.
pub fn sync_pair(
    client: SessionClient,
    scope: Option<WbVariant>,
    group_id: &str,
    source_member_id: &str,
    target_member_id: &str,
    preview_token: &str,
    mode: &str,
) -> Result<Value, String> {
    let context = resolve_pair(client, scope, group_id, source_member_id, target_member_id)?;
    if preview_token.trim().is_empty() {
        return Err("缺少会话同步预览凭据".to_string());
    }
    let selection = parse_selection(group_id, preview_token, mode)?;
    run_pair_sync(client, scope, &context, &[selection])
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupUnifyTarget {
    pub target_member_id: String,
    pub preview_token: String,
    pub mode: String,
}

/// Apply an explicit WorkBuddy group choice in one lifecycle window. Only a running
/// variant whose current login is a write target is closed, and only variants that
/// were closed here are reopened. Pair kernels still validate every preview token.
pub fn sync_unify_batch(
    client: SessionClient,
    scope: Option<WbVariant>,
    group_id: &str,
    source_member_id: &str,
    targets: &[GroupUnifyTarget],
) -> Result<Value, String> {
    if client != SessionClient::Workbuddy || scope.is_some() {
        return Err("仅 WorkBuddy 会话支持自动重启后整组统一".to_string());
    }
    if targets.is_empty() {
        return Err("没有需要同步的目标副本".to_string());
    }
    let mut seen = HashSet::new();
    let mut prepared = Vec::with_capacity(targets.len());
    for target in targets {
        if !seen.insert(target.target_member_id.as_str()) {
            return Err("目标副本重复，请重新检查会话".to_string());
        }
        let pair = resolve_pair(
            client,
            scope,
            group_id,
            source_member_id,
            &target.target_member_id,
        )?;
        let selection = parse_selection(group_id, &target.preview_token, &target.mode)?;
        prepared.push((pair, selection));
    }

    let restart_variants = WbVariant::ALL
        .into_iter()
        .filter(|variant| {
            prepared.iter().any(|(pair, _)| {
                account::variant_of(&pair.target_account) == *variant
                    && running_target_needs_restart(*variant, &pair.target.uid)
            })
        })
        .collect::<Vec<_>>();
    let mut closed = Vec::new();
    for variant in restart_variants {
        if let Err(error) = process::close_workbuddy(variant, 20) {
            let reopen_errors = reopen_workbuddy_variants(&closed);
            let suffix = if reopen_errors.is_empty() {
                String::new()
            } else {
                format!(
                    "；此前关闭的客户端重新打开失败：{}",
                    reopen_errors.join("；")
                )
            };
            return Err(format!(
                "关闭 {}失败：{error}{suffix}",
                workbuddy_variant_label(variant)
            ));
        }
        closed.push(variant);
    }

    let mut combined = json!({ "client": client.as_str(), "groupId": group_id, "synced": [], "skipped": [], "errors": [], "needsRecovery": false, "temporaryFiles": [], "restartedVariants": [] });
    for (pair, selection) in prepared {
        match run_pair_sync(client, scope, &pair, &[selection]) {
            Ok(report) => {
                merge_sync_report(&mut combined, report);
                if combined["needsRecovery"] == true {
                    break;
                }
            }
            Err(error) => {
                combined["errors"].as_array_mut().unwrap().push(json!({
                    "error": format!("{}：{error}", pair.target.uid),
                }));
                break;
            }
        }
    }

    if combined["needsRecovery"] == true {
        combined["errors"].as_array_mut().unwrap().push(json!({
            "error": "会话写入待恢复，已暂停重新打开客户端；请先处理恢复提示",
        }));
        return Ok(combined);
    }
    for variant in &closed {
        match session::recover_pending_session_operations(*variant) {
            Ok(recovery) if !crate::modules::switch::recovery_blocks_startup(&recovery) => {}
            Ok(recovery) => {
                combined["needsRecovery"] = json!(true);
                combined["errors"].as_array_mut().unwrap().push(json!({
                    "error": format!("{}仍有待恢复的会话写入（{}），已暂停重新打开客户端", workbuddy_variant_label(*variant), crate::modules::switch::recovery_blocking_detail(&recovery)),
                }));
            }
            Err(error) => {
                combined["needsRecovery"] = json!(true);
                combined["errors"].as_array_mut().unwrap().push(json!({
                    "error": format!("{}无法检查会话恢复状态（{error}），已暂停重新打开客户端", workbuddy_variant_label(*variant)),
                }));
            }
        }
    }
    if combined["needsRecovery"] == true {
        return Ok(combined);
    }
    let mut reopened = Vec::new();
    for variant in closed {
        if let Err(error) = process::launch_workbuddy(variant, None) {
            combined["errors"].as_array_mut().unwrap().push(json!({
                "error": format!("{}会话已处理，但客户端重新打开失败：{error}", workbuddy_variant_label(variant)),
            }));
        } else {
            reopened.push(variant.as_str());
        }
    }
    combined["restartedVariants"] = json!(reopened);
    Ok(combined)
}

fn running_target_needs_restart(variant: WbVariant, target_uid: &str) -> bool {
    should_restart_running_target(
        process::is_workbuddy_running(variant),
        session::current_user_uid(variant).as_deref(),
        target_uid,
    )
}

fn should_restart_running_target(
    running: bool,
    current_uid: Option<&str>,
    target_uid: &str,
) -> bool {
    running && current_uid.map_or(true, |uid| uid == target_uid)
}

fn workbuddy_variant_label(variant: WbVariant) -> &'static str {
    match variant {
        WbVariant::Cn => "WorkBuddy 国内版",
        WbVariant::Ai => "WorkBuddy 国际版",
    }
}

fn reopen_workbuddy_variants(variants: &[WbVariant]) -> Vec<String> {
    variants
        .iter()
        .filter_map(|variant| {
            process::launch_workbuddy(*variant, None)
                .err()
                .map(|error| format!("{}：{error}", workbuddy_variant_label(*variant)))
        })
        .collect()
}

/// Recompute the group source on the server and sync only targets proven fast-forward safe.
pub fn sync_safe_batch(
    client: SessionClient,
    scope: Option<WbVariant>,
    group_id: &str,
) -> Result<Value, String> {
    let detail = detail(client, scope, group_id)?;
    let source_member_id = detail
        .get("safeSourceMemberId")
        .and_then(Value::as_str)
        .ok_or_else(|| "该组无法确认安全同步来源".to_string())?
        .to_string();
    let targets = detail
        .get("members")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|member| {
            member.get("memberId").and_then(Value::as_str) != Some(source_member_id.as_str())
                && member.get("versionStatus").and_then(Value::as_str) == Some("behind")
        })
        .filter_map(|member| {
            member
                .get("memberId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect::<Vec<_>>();
    let mut combined = json!({ "client": client.as_str(), "groupId": group_id, "synced": [], "skipped": [], "errors": [], "needsRecovery": false });
    for target_member_id in targets {
        let pair = resolve_pair(
            client,
            scope,
            group_id,
            &source_member_id,
            &target_member_id,
        )?;
        let preview = preview_resolved_pair(client, scope, &pair)?;
        if preview.get("verdict").and_then(Value::as_str) != Some("fastForward") {
            combined["skipped"].as_array_mut().unwrap().push(json!({
                "groupId": group_id,
                "targetMemberId": target_member_id,
                "reasonCode": "recheckNotFastForward",
                "message": "重新检查后该副本不再属于安全快进范围",
            }));
            continue;
        }
        let token = preview
            .get("previewToken")
            .and_then(Value::as_str)
            .ok_or_else(|| "重新预览未返回可执行凭据".to_string())?;
        let selection = parse_selection(group_id, token, "fastForward")?;
        let report = run_pair_sync(client, scope, &pair, &[selection])?;
        merge_sync_report(&mut combined, report);
    }
    Ok(combined)
}

/// Copy one member into a compatible saved account and register it in the same namespace.
pub fn add_member(
    client: SessionClient,
    scope: Option<WbVariant>,
    group_id: &str,
    source_member_id: &str,
    target_account_id: &str,
) -> Result<Value, String> {
    client.validate_scope(scope)?;
    let paths = client.store_paths();
    let accounts = account::load_accounts_at(&account::accounts_file_in(&paths.store_root));
    let target = accounts
        .iter()
        .find(|account| account.get("id").and_then(Value::as_str) == Some(target_account_id))
        .cloned()
        .ok_or_else(|| "目标账号不存在".to_string())?;
    let target_uid = account::get_str(&target, "uid")
        .map(|uid| uid.trim().to_string())
        .filter(|uid| !uid.is_empty())
        .ok_or_else(|| "目标账号缺少 uid".to_string())?;
    validate_target_compatibility(client, scope, &target)?;

    let store = match session_link::load_store(&paths) {
        StoreState::Ready(store) => store,
        StoreState::Missing => return Err("会话关联组不存在".to_string()),
        StoreState::Unavailable(reason) => return Err(format!("会话关联组暂不可用：{reason}")),
    };
    let group = store
        .groups
        .iter()
        .find(|group| group.id == group_id && group_is_in_scope(client, scope, group))
        .cloned()
        .ok_or_else(|| "会话关联组不存在或不属于当前客户端".to_string())?;
    let source = group
        .members
        .iter()
        .find(|member| member.member_id == source_member_id && member.state == MemberState::Active)
        .cloned()
        .ok_or_else(|| "来源成员已失效，请刷新会话组后重试".to_string())?;
    if source.uid == target_uid {
        return Err("目标账号已是该会话组成员".to_string());
    }
    if group
        .members
        .iter()
        .any(|member| member.uid == target_uid && member.state == MemberState::Active)
    {
        return Ok(
            json!({ "status": "alreadyLinked", "client": client.as_str(), "groupId": group_id, "targetAccountId": target_account_id }),
        );
    }

    match client {
        SessionClient::Workbuddy => {
            let source_acc = account_by_uid(&accounts, &source.uid)
                .ok_or_else(|| "来源账号已不在本机账号库中".to_string())?;
            let report =
                session::copy_sessions_cross(&source_acc, &target, &[source.session_id.clone()])?;
            let copied = report
                .get("copied")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let linked = report
                .get("alreadyLinked")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            Ok(json!({
                "status": if copied > 0 { "linked" } else if linked > 0 { "alreadyLinked" } else { "failed" },
                "client": client.as_str(),
                "groupId": group_id,
                "report": report,
            }))
        }
        SessionClient::CodebuddyIde | SessionClient::VscodeExt => {
            let variant = scope.unwrap_or_else(|| account::variant_of(&target));
            let _operation_lock = session_link::try_acquire_client_ops_lock(&paths)?;
            // Recheck under the operation lock: the underlying IDE/plugin copy kernels are not idempotent.
            let current = match session_link::load_store(&paths) {
                StoreState::Ready(store) => store,
                StoreState::Missing => return Err("会话关联组不存在".to_string()),
                StoreState::Unavailable(reason) => {
                    return Err(format!("会话关联组暂不可用：{reason}"))
                }
            };
            let current_group = current
                .groups
                .iter()
                .find(|candidate| {
                    candidate.id == group_id && group_is_in_scope(client, scope, candidate)
                })
                .ok_or_else(|| "会话关联组已变化，请刷新后重试".to_string())?;
            if current_group
                .members
                .iter()
                .any(|member| member.uid == target_uid && member.state == MemberState::Active)
            {
                return Ok(
                    json!({ "status": "alreadyLinked", "client": client.as_str(), "groupId": group_id, "targetAccountId": target_account_id }),
                );
            }
            if client == SessionClient::CodebuddyIde {
                let flavor = ide_flavor(variant);
                if flavor.is_running() {
                    return Err(
                        "检测到 CodeBuddy IDE 正在运行，请先完全退出后再添加关联账号。".to_string(),
                    );
                }
            } else if vscode_ext::is_vscode_running() {
                return Err("检测到 VS Code 正在运行，请先完全退出后再添加关联账号。".to_string());
            }
            let root = client
                .data_root()
                .ok_or_else(|| "未找到客户端会话数据目录".to_string())?;
            let spec = client
                .store_spec()
                .ok_or_else(|| "客户端数据仓不可用".to_string())?;
            let (workspace_hash, _, content) = vscode_session_sync::session_location_and_content(
                spec,
                &root,
                &source.uid,
                &source.session_id,
            )
            .ok_or_else(|| "来源会话索引已不存在，请刷新后重试".to_string())?;
            if !matches!(content, ContentState::Ready(_)) {
                return Err("来源会话内容缺失或无法确认，不能复制".to_string());
            }
            let item = CopyItem {
                workspace_hash,
                conversation_id: source.session_id.clone(),
            };
            let backup_root = paths
                .backup_root()
                .join(spec.backup_kind)
                .join(config::utc_iso());
            let report = match client {
                SessionClient::CodebuddyIde => {
                    codebuddy_ide_session::copy_codebuddy_ide_sessions_in(
                        &root,
                        &backup_root,
                        &source.uid,
                        &target_uid,
                        &[item],
                    )?
                }
                SessionClient::VscodeExt => vscode_session::copy_sessions_in(
                    &root,
                    &backup_root,
                    &source.uid,
                    &target_uid,
                    &[item],
                )?,
                SessionClient::Workbuddy => unreachable!(),
            };
            let copied = report
                .get("copied")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            if copied == 0 {
                return Ok(
                    json!({ "status": "failed", "client": client.as_str(), "groupId": group_id, "report": report }),
                );
            }
            let link_errors = match client {
                SessionClient::CodebuddyIde => {
                    codebuddy_ide_session_sync::register_copied_sessions(
                        &root, &paths, variant, &report,
                    )
                }
                SessionClient::VscodeExt => vscode_session_sync::register_copied_sessions_in(
                    VSCODE_STORE,
                    &root,
                    &paths,
                    variant,
                    &report,
                ),
                SessionClient::Workbuddy => unreachable!(),
            };
            if !link_errors.is_empty() {
                return Ok(json!({
                    "status": "copiedUnlinked",
                    "client": client.as_str(),
                    "groupId": group_id,
                    "report": report,
                    "linkErrors": link_errors,
                }));
            }
            Ok(
                json!({ "status": "linked", "client": client.as_str(), "groupId": group_id, "report": report, "linkErrors": [] }),
            )
        }
    }
}

/// Remove one member from a group, keeping the account's session content untouched.
///
/// Group-management data only: no client kernel runs and no session file is written. Pair
/// baselines that reference the member are dropped together with it (`validate_store` requires
/// pair references to stay inside the group); a group left without members is deleted.
pub fn remove_member(
    client: SessionClient,
    scope: Option<WbVariant>,
    group_id: &str,
    member_id: &str,
) -> Result<Value, String> {
    client.validate_scope(scope)?;
    let paths = client.store_paths();
    // 单次存储锁内完成读改写：失败不写盘、不推进 revision（`with_link_store_write` 契约）。
    let (group_removed, remaining) = session_link::with_link_store_write(&paths, |store| {
        remove_member_in(store, client, scope, group_id, member_id)
    })?;
    Ok(json!({
        "status": if group_removed { "groupRemoved" } else { "removed" },
        "client": client.as_str(),
        "groupId": group_id,
        "memberId": member_id,
        "remaining": remaining,
    }))
}

/// [`remove_member`] 的纯变更部分：与存储 IO 分离，便于用固定夹具覆盖不变量。
fn remove_member_in(
    store: &mut crate::modules::session_link::LinkStore,
    client: SessionClient,
    scope: Option<WbVariant>,
    group_id: &str,
    member_id: &str,
) -> Result<(bool, usize), String> {
    let group = store
        .groups
        .iter_mut()
        .find(|group| group.id == group_id && group_is_in_scope(client, scope, group))
        .ok_or_else(|| "会话关联组不存在或不属于当前客户端".to_string())?;
    if !group
        .members
        .iter()
        .any(|member| member.member_id == member_id)
    {
        return Err("成员不存在，请刷新后重试".to_string());
    }
    group.members.retain(|member| member.member_id != member_id);
    group
        .pair_bases
        .retain(|pair| !pair.member_ids.iter().any(|id| id == member_id));
    let remaining = group.members.len();
    let group_removed = remaining == 0;
    if group_removed {
        store.groups.retain(|group| group.id != group_id);
    }
    Ok((group_removed, remaining))
}

#[derive(Debug, Clone)]
struct PairContext {
    group: LinkGroup,
    source: LinkMember,
    target: LinkMember,
    source_account: Value,
    target_account: Value,
}

fn resolve_pair(
    client: SessionClient,
    scope: Option<WbVariant>,
    group_id: &str,
    source_member_id: &str,
    target_member_id: &str,
) -> Result<PairContext, String> {
    client.validate_scope(scope)?;
    let paths = client.store_paths();
    let store = match session_link::load_store(&paths) {
        StoreState::Ready(store) => store,
        StoreState::Missing => return Err("会话关联组不存在".to_string()),
        StoreState::Unavailable(reason) => return Err(format!("会话关联组暂不可用：{reason}")),
    };
    let group = store
        .groups
        .iter()
        .find(|group| group.id == group_id && group_is_in_scope(client, scope, group))
        .cloned()
        .ok_or_else(|| "会话关联组不存在或不属于当前客户端".to_string())?;
    let source = group
        .members
        .iter()
        .find(|member| member.member_id == source_member_id && member.state == MemberState::Active)
        .cloned()
        .ok_or_else(|| "来源成员已失效，请刷新会话组".to_string())?;
    let target = group
        .members
        .iter()
        .find(|member| member.member_id == target_member_id && member.state == MemberState::Active)
        .cloned()
        .ok_or_else(|| "目标成员已失效，请刷新会话组".to_string())?;
    if source.member_id == target.member_id || source.uid == target.uid {
        return Err("来源和目标必须是不同账号成员".to_string());
    }
    let accounts = account::load_accounts_at(&account::accounts_file_in(&paths.store_root));
    let source_account = account_by_uid(&accounts, &source.uid)
        .ok_or_else(|| "来源账号已不在本机账号库中".to_string())?;
    let target_account = account_by_uid(&accounts, &target.uid)
        .ok_or_else(|| "目标账号已不在本机账号库中".to_string())?;
    validate_target_compatibility(client, scope, &target_account)?;
    Ok(PairContext {
        group,
        source,
        target,
        source_account,
        target_account,
    })
}

fn preview_resolved_pair(
    client: SessionClient,
    scope: Option<WbVariant>,
    pair: &PairContext,
) -> Result<Value, String> {
    let paths = client.store_paths();
    let report = match client {
        SessionClient::Workbuddy => {
            session::session_links_preview_cross(&pair.source_account, &pair.target_account)?
        }
        SessionClient::CodebuddyIde => {
            let variant = scope.ok_or_else(|| "CodeBuddy IDE 缺少档位".to_string())?;
            let root = client
                .data_root()
                .ok_or_else(|| "未找到 CodeBuddy IDE 会话数据目录".to_string())?;
            vscode_session_sync::links_preview_in_for_variant(
                CODEBUDDY_IDE_STORE,
                &root,
                &paths,
                &pair.source.uid,
                &pair.target_account,
                variant,
            )?
        }
        SessionClient::VscodeExt => {
            let root = client
                .data_root()
                .ok_or_else(|| "未找到 VS Code 插件会话数据目录".to_string())?;
            vscode_session_sync::links_preview_in(
                VSCODE_STORE,
                &root,
                &paths,
                &pair.source.uid,
                &pair.target_account,
            )?
        }
    };
    let preview = report
        .get("groups")
        .and_then(Value::as_array)
        .and_then(|groups| {
            groups.iter().find(|item| {
                item.get("groupId").and_then(Value::as_str) == Some(pair.group.id.as_str())
            })
        })
        .cloned()
        .ok_or_else(|| "该组当前没有可预览的来源与目标副本".to_string())?;
    let mut modes = preview.get("availableModes").cloned().unwrap_or(json!([]));
    if preview.get("verdict").and_then(Value::as_str) == Some("ahead")
        && preview
            .get("previewToken")
            .and_then(Value::as_str)
            .is_some()
    {
        modes = json!(["unifyOverwrite"]);
    }
    Ok(json!({
        "client": client.as_str(),
        "variantScope": scope.map(WbVariant::as_str),
        "groupId": pair.group.id,
        "sourceMemberId": pair.source.member_id,
        "targetMemberId": pair.target.member_id,
        "verdict": preview.get("verdict").cloned().unwrap_or(Value::Null),
        "availableModes": modes,
        "previewToken": preview.get("previewToken").cloned().unwrap_or(Value::Null),
        "reason": preview.get("reason").cloned().unwrap_or(json!("无法确认")),
        "recordCount": preview.get("recordCount").cloned().unwrap_or(Value::Null),
        "extraTargetCount": preview.get("extraB").cloned().unwrap_or(json!(0)),
    }))
}

fn run_pair_sync(
    client: SessionClient,
    scope: Option<WbVariant>,
    pair: &PairContext,
    selections: &[SyncSelection],
) -> Result<Value, String> {
    let paths = client.store_paths();
    let report = match client {
        SessionClient::Workbuddy => {
            session::sync_sessions_cross(&pair.source_account, &pair.target_account, selections)?
        }
        SessionClient::CodebuddyIde => {
            let variant = scope.ok_or_else(|| "CodeBuddy IDE 缺少档位".to_string())?;
            let _operation_lock = session_link::try_acquire_client_ops_lock(&paths)?;
            if ide_flavor(variant).is_running() {
                return Err("检测到 CodeBuddy IDE 正在运行，请先完全退出后再同步会话。".to_string());
            }
            let root = client
                .data_root()
                .ok_or_else(|| "未找到 CodeBuddy IDE 会话数据目录".to_string())?;
            vscode_session_sync::sync_selected_in_for_variant(
                CODEBUDDY_IDE_STORE,
                &root,
                &paths,
                &pair.source.uid,
                &pair.target_account,
                selections,
                variant,
            )?
        }
        SessionClient::VscodeExt => {
            let _operation_lock = session_link::try_acquire_client_ops_lock(&paths)?;
            if vscode_ext::is_vscode_running() {
                return Err("检测到 VS Code 正在运行，请先完全退出后再同步会话。".to_string());
            }
            let root = client
                .data_root()
                .ok_or_else(|| "未找到 VS Code 插件会话数据目录".to_string())?;
            vscode_session_sync::sync_selected_in(
                VSCODE_STORE,
                &root,
                &paths,
                &pair.source.uid,
                &pair.target_account,
                selections,
            )?
        }
    };
    Ok(json!({
        "client": client.as_str(),
        "groupId": pair.group.id,
        "sourceMemberId": pair.source.member_id,
        "targetMemberId": pair.target.member_id,
        "synced": report.get("synced").cloned().unwrap_or(json!([])),
        "skipped": report.get("skipped").cloned().unwrap_or(json!([])),
        "errors": report.get("errors").cloned().unwrap_or(json!([])),
        "needsRecovery": report.get("needsRecovery").cloned().unwrap_or(json!(false)),
        "temporaryFiles": report.get("temporaryFiles").cloned().unwrap_or(json!([])),
    }))
}

fn parse_selection(
    group_id: &str,
    preview_token: &str,
    mode: &str,
) -> Result<SyncSelection, String> {
    if !matches!(mode, "fastForward" | "overwrite" | "unifyOverwrite") {
        return Err("不支持的会话同步模式".to_string());
    }
    session::parse_sync_selections(Some(&json!([{
        "groupId": group_id,
        "previewToken": preview_token,
        "mode": mode,
    }])))?
    .into_iter()
    .next()
    .ok_or_else(|| "会话同步选择项为空".to_string())
}

fn merge_sync_report(into: &mut Value, item: Value) {
    for key in ["synced", "skipped", "errors", "temporaryFiles"] {
        let values = item
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        into[key].as_array_mut().unwrap().extend(values);
    }
    if item.get("needsRecovery").and_then(Value::as_bool) == Some(true) {
        into["needsRecovery"] = json!(true);
    }
}

fn validate_target_compatibility(
    client: SessionClient,
    scope: Option<WbVariant>,
    target: &Value,
) -> Result<(), String> {
    match client {
        SessionClient::Workbuddy => Ok(()),
        SessionClient::CodebuddyIde => {
            let expected = scope.ok_or_else(|| "CodeBuddy IDE 缺少档位".to_string())?;
            if account::variant_of(target) != expected {
                return Err("目标账号与当前 CodeBuddy IDE 档位不兼容".to_string());
            }
            Ok(())
        }
        // The plugin uses one account-scoped store across account regions.
        SessionClient::VscodeExt => Ok(()),
    }
}

fn group_is_in_scope(client: SessionClient, scope: Option<WbVariant>, group: &LinkGroup) -> bool {
    match client {
        SessionClient::CodebuddyIde => Some(group.variant) == scope,
        SessionClient::Workbuddy | SessionClient::VscodeExt => true,
    }
}

fn account_by_uid(accounts: &[Value], uid: &str) -> Option<Value> {
    accounts
        .iter()
        .find(|account| account::get_str(account, "uid").as_deref() == Some(uid))
        .cloned()
}

fn ide_flavor(variant: WbVariant) -> codebuddy_ide_session::IdeFlavor {
    match variant {
        WbVariant::Cn => codebuddy_ide_session::IdeFlavor::Cn,
        WbVariant::Ai => codebuddy_ide_session::IdeFlavor::Intl,
    }
}

fn group_payload(
    client: SessionClient,
    scope: Option<WbVariant>,
    paths: &SessionPaths,
    group: &LinkGroup,
    accounts: &[Value],
    cache: &mut HashMap<(String, String), Vec<Value>>,
    include_detail: bool,
) -> Value {
    let root = client.data_root();
    let spec = client.store_spec();
    let mut views = group
        .members
        .iter()
        .map(|member| {
            let account = account_by_uid(accounts, &member.uid);
            let account_name = account
                .as_ref()
                .map(account::account_display_name)
                .unwrap_or_else(|| member.uid.clone());
            let account_key = account
                .as_ref()
                .and_then(|account| account::get_str(account, "id"))
                .or_else(|| member.account_id.clone())
                .unwrap_or_else(|| member.uid.clone());
            let (title, project_label, updated_at, content) =
                member_snapshot(client, &root, spec, group, member, cache);
            let mut member = member.clone();
            // Correct legacy plugin labels from the account library; region never selects its data root.
            if client == SessionClient::VscodeExt {
                if let Some(account) = account.as_ref() {
                    member.variant = Some(account::variant_of(account));
                }
            }
            MemberView {
                member,
                account_key,
                account_name,
                title,
                project_label,
                updated_at,
                content,
                reason: String::new(),
                version_status: "unknown",
            }
        })
        .collect::<Vec<_>>();
    views.sort_by(|left, right| {
        left.account_key
            .cmp(&right.account_key)
            .then_with(|| left.member.uid.cmp(&right.member.uid))
            .then_with(|| left.member.member_id.cmp(&right.member.member_id))
    });

    let active = views
        .iter()
        .enumerate()
        .filter(|(_, view)| view.member.state == MemberState::Active)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let mut matrix: HashMap<(usize, usize), (SyncVerdict, String)> = HashMap::new();
    for &source_index in &active {
        for &target_index in &active {
            if source_index == target_index {
                continue;
            }
            let source = &views[source_index];
            let target = &views[target_index];
            let baseline = session_link::load_pair_baseline(
                paths,
                group,
                &source.member.member_id,
                &target.member.member_id,
            );
            let decision = session_link::decide_sync(&source.content, &target.content, &baseline);
            matrix.insert(
                (source_index, target_index),
                (decision.verdict, decision.reason),
            );
        }
    }
    let (safe_source, aggregate_status) = aggregate_group_state(&mut views, &active, &matrix);
    let divergence = common_base_branches(&views, &active);
    let summary_status = if divergence.is_some() {
        "diverge"
    } else {
        aggregate_status
    };
    let title = views
        .iter()
        .find(|view| !view.title.trim().is_empty())
        .map(|view| view.title.clone())
        .unwrap_or_else(|| "会话组".to_string());
    let project_label = views
        .iter()
        .find(|view| !view.project_label.is_empty())
        .map(|view| view.project_label.clone())
        .unwrap_or_default();
    let latest_activity_at = views.iter().map(|view| view.updated_at).max().unwrap_or(0);
    let account_names = views
        .iter()
        .map(|view| view.account_name.clone())
        .collect::<Vec<_>>();
    let group_key = format!(
        "{}:{}:{}",
        client.as_str(),
        scope.map(WbVariant::as_str).unwrap_or("all"),
        group.id
    );
    let mut result = json!({
        "key": group_key,
        "client": client.as_str(),
        "variantScope": scope.map(WbVariant::as_str),
        "groupId": group.id,
        "groupVariant": group.variant.as_str(),
        "title": title,
        "projectLabel": project_label,
        "latestActivityAt": latest_activity_at,
        "memberCount": group.members.len(),
        "activeMemberCount": active.len(),
        "accountNames": account_names,
        "summaryStatus": summary_status,
        "summaryText": summary_text(summary_status),
        "safeSourceMemberId": safe_source.map(|index| views[index].member.member_id.clone()),
        "hasSafeSource": safe_source.is_some(),
    });
    if include_detail {
        if let Some(divergence) = divergence {
            result["divergence"] = json!({
                "commonMemberIds": divergence.common.iter().map(|&index| &views[index].member.member_id).collect::<Vec<_>>(),
                "branches": divergence.branches.iter().map(|branch| branch.iter().map(|&index| &views[index].member.member_id).collect::<Vec<_>>()).collect::<Vec<_>>(),
            });
        }
        let member_payloads = views.iter().map(|view| json!({
            "memberId": view.member.member_id,
            "accountId": view.member.account_id,
            "uid": view.member.uid,
            "sessionId": view.member.session_id,
            "accountName": view.account_name,
            "variant": session_link::member_variant(group, &view.member).as_str(),
            "linkState": view.member.state.as_str(),
            "versionStatus": view.version_status,
            "title": view.title,
            "projectLabel": view.project_label,
            "updatedAt": view.updated_at,
            "recordCount": content_count(&view.content),
            "contentPreview": content_preview(&view.content),
            "contentState": content_state_name(&view.content),
            "reason": view.reason,
            "canBeSource": view.member.state == MemberState::Active && matches!(view.content, ContentState::Ready(_)),
        })).collect::<Vec<_>>();
        let target_options = compatible_accounts(client, scope, group, accounts);
        result["members"] = json!(member_payloads);
        result["addTargets"] = json!(target_options);
    }
    result
}

/// Recognize one present shared snapshot followed by independent append-only branches.
/// This uses normalized ordered content, so timestamps and record counts cannot invent ancestry.
/// A more complex history stays in the generic divergence state.
#[derive(Debug, PartialEq, Eq)]
struct CommonBaseBranches {
    common: Vec<usize>,
    branches: Vec<Vec<usize>>,
}

fn common_base_branches(views: &[MemberView], active: &[usize]) -> Option<CommonBaseBranches> {
    if active.len() < 3 || active.len() != views.len() {
        return None;
    }
    let lines = |index: usize| match &views[index].content {
        ContentState::Ready(snapshot) => Some(snapshot.normalized.line_digests.as_slice()),
        _ => None,
    };
    let mut versions: Vec<Vec<usize>> = Vec::new();
    for &index in active {
        let content = lines(index)?;
        if let Some(version) = versions
            .iter_mut()
            .find(|version| lines(version[0]) == Some(content))
        {
            version.push(index);
        } else {
            versions.push(vec![index]);
        }
    }
    if versions.len() < 3 {
        return None;
    }
    let common_index = versions.iter().position(|version| {
        let common = lines(version[0]).expect("active members have readable content");
        versions
            .iter()
            .filter(|other| *other != version)
            .all(|other| {
                let branch = lines(other[0]).expect("active members have readable content");
                branch.len() > common.len() && branch.starts_with(common)
            })
    })?;
    let common = versions.remove(common_index);
    // Each remaining version must be independently advanced from the shared snapshot.
    if versions.iter().enumerate().any(|(index, branch)| {
        versions.iter().skip(index + 1).any(|other| {
            let left = lines(branch[0]).expect("active members have readable content");
            let right = lines(other[0]).expect("active members have readable content");
            left.starts_with(right) || right.starts_with(left)
        })
    }) {
        return None;
    }
    Some(CommonBaseBranches {
        common,
        branches: versions,
    })
}

/// Reduce pairwise decisions into stable member states and a group summary.
///
/// `views` are already ordered by account key, UID, and member ID. The reducer is deliberately
/// independent of storage and process state so the conservative source-selection contract can be
/// covered with deterministic unit tests.
fn aggregate_group_state(
    views: &mut [MemberView],
    active: &[usize],
    matrix: &HashMap<(usize, usize), (SyncVerdict, String)>,
) -> (Option<usize>, &'static str) {
    let mut safe_candidates = active
        .iter()
        .copied()
        .filter(|&candidate| {
            if !matches!(&views[candidate].content, ContentState::Ready(_)) {
                return false;
            }
            active
                .iter()
                .copied()
                .filter(|&other| other != candidate)
                .all(|other| {
                    matrix.get(&(candidate, other)).is_some_and(|(verdict, _)| {
                        matches!(verdict, SyncVerdict::Identical | SyncVerdict::FastForward)
                    })
                })
        })
        .collect::<Vec<_>>();
    safe_candidates.sort_by(|&left, &right| {
        views[left]
            .account_key
            .cmp(&views[right].account_key)
            .then_with(|| views[left].member.uid.cmp(&views[right].member.uid))
            .then_with(|| {
                views[left]
                    .member
                    .member_id
                    .cmp(&views[right].member.member_id)
            })
    });
    let safe_source = safe_candidates.first().copied();

    let mut has_behind = false;
    let mut has_diverge = false;
    let mut has_missing = false;
    let mut has_unknown = false;
    for index in 0..views.len() {
        let view = &mut views[index];
        match view.member.state {
            MemberState::Stale => {
                view.version_status = "stale";
                view.reason = "该副本已标记为失效".to_string();
            }
            MemberState::Superseded => {
                view.version_status = "superseded";
                view.reason = "该副本已被更新成员替代".to_string();
            }
            MemberState::Active => match &view.content {
                ContentState::Missing => {
                    view.version_status = "missing";
                    view.reason = "会话内容不存在，无法同步".to_string();
                    has_missing = true;
                }
                ContentState::Unavailable(reason) => {
                    view.version_status = "unknown";
                    view.reason = reason.clone();
                    has_unknown = true;
                }
                ContentState::Ready(_) => {
                    if let Some(source_index) = safe_source {
                        if index == source_index
                            || matrix
                                .get(&(source_index, index))
                                .is_some_and(|(verdict, _)| *verdict == SyncVerdict::Identical)
                        {
                            view.version_status = "latest";
                            if index != source_index {
                                view.reason = "内容与操作来源一致".to_string();
                            }
                        } else if let Some((SyncVerdict::FastForward, reason)) =
                            matrix.get(&(source_index, index))
                        {
                            view.version_status = "behind";
                            view.reason = reason.clone();
                            has_behind = true;
                        } else {
                            view.version_status = "unknown";
                            view.reason = "重新检查后无法确认此成员状态".to_string();
                            has_unknown = true;
                        }
                    } else {
                        let reasons = active
                            .iter()
                            .filter_map(|other| matrix.get(&(*other, index)))
                            .collect::<Vec<_>>();
                        if reasons
                            .iter()
                            .any(|(verdict, _)| *verdict == SyncVerdict::Diverge)
                        {
                            view.version_status = "diverge";
                            view.reason = reasons
                                .iter()
                                .find(|(verdict, _)| *verdict == SyncVerdict::Diverge)
                                .map(|(_, reason)| reason.clone())
                                .unwrap_or_default();
                            has_diverge = true;
                        } else {
                            view.version_status = "unknown";
                            view.reason = reasons
                                .first()
                                .map(|(_, reason)| reason.clone())
                                .unwrap_or_else(|| "缺少可比较的关联成员".to_string());
                            has_unknown = true;
                        }
                    }
                }
            },
        }
    }

    let summary_status = if safe_source.is_some() {
        if has_behind {
            "behind"
        } else {
            "latest"
        }
    } else if has_diverge {
        "diverge"
    } else if has_missing {
        "missing"
    } else if has_unknown {
        "unknown"
    } else {
        "unknown"
    };

    (safe_source, summary_status)
}

fn member_snapshot(
    client: SessionClient,
    root: &Option<PathBuf>,
    spec: Option<SessionStoreSpec>,
    group: &LinkGroup,
    member: &LinkMember,
    cache: &mut HashMap<(String, String), Vec<Value>>,
) -> (String, String, i64, ContentState) {
    match client {
        SessionClient::Workbuddy => {
            let variant = session_link::member_variant(group, member);
            let rows = cache
                .entry((variant.as_str().to_string(), member.uid.clone()))
                .or_insert_with(|| {
                    session::list_sessions_for_user(variant, &member.uid)
                        .as_array()
                        .cloned()
                        .unwrap_or_default()
                });
            let row = rows.iter().find(|row| {
                row.get("id").and_then(Value::as_str) == Some(member.session_id.as_str())
            });
            let title = row
                .and_then(|row| row.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("会话标题暂不可用")
                .to_string();
            let cwd = row
                .and_then(|row| row.get("cwd"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let project = basename(cwd);
            let updated_at = row
                .and_then(|row| row.get("updatedAt"))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let member_paths = SessionPaths::for_variant(variant);
            let content = if row.is_none() {
                ContentState::Missing
            } else {
                session::member_content_state(&member_paths, &member.session_id)
            };
            (
                title,
                if project.is_empty() {
                    String::new()
                } else {
                    format!("项目 {project}")
                },
                updated_at,
                content,
            )
        }
        SessionClient::CodebuddyIde | SessionClient::VscodeExt => {
            let variant = session_link::member_variant(group, member);
            let rows = cache
                .entry((variant.as_str().to_string(), member.uid.clone()))
                .or_insert_with(|| {
                    let Some(root) = root.as_ref() else {
                        return Vec::new();
                    };
                    vscode_session::list_sessions_in_store(spec.unwrap(), root, &member.uid)
                        .get("sessions")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                });
            let row = rows.iter().find(|row| {
                row.get("id").and_then(Value::as_str) == Some(member.session_id.as_str())
            });
            let title = row
                .and_then(|row| row.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("会话标题暂不可用")
                .to_string();
            let hash = row
                .and_then(|row| row.get("workspaceHash"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let project = if hash.is_empty() {
                String::new()
            } else {
                format!("工作区 {}", hash.chars().take(8).collect::<String>())
            };
            let updated_at = row
                .and_then(|row| row.get("updatedAt"))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let content = match (root.as_ref(), spec) {
                (Some(root), Some(spec)) => vscode_session_sync::session_location_and_content(
                    spec,
                    root,
                    &member.uid,
                    &member.session_id,
                )
                .map(|(_, _, content)| content)
                .unwrap_or(ContentState::Missing),
                _ => ContentState::Unavailable("未找到客户端会话数据目录".to_string()),
            };
            (title, project, updated_at, content)
        }
    }
}

fn compatible_accounts(
    client: SessionClient,
    scope: Option<WbVariant>,
    group: &LinkGroup,
    accounts: &[Value],
) -> Vec<Value> {
    accounts
        .iter()
        .filter(|target| {
            let Some(uid) = account::get_str(target, "uid") else {
                return false;
            };
            if group
                .members
                .iter()
                .any(|member| member.uid == uid && member.state == MemberState::Active)
            {
                return false;
            }
            validate_target_compatibility(client, scope, target).is_ok()
                && (client == SessionClient::Workbuddy || vscode_session::is_safe_uid(&uid))
        })
        .map(account::account_meta)
        .collect()
}

fn content_count(content: &ContentState) -> Option<usize> {
    match content {
        ContentState::Ready(snapshot) => Some(snapshot.normalized.record_count),
        _ => None,
    }
}

fn content_preview(content: &ContentState) -> Vec<Value> {
    let ContentState::Ready(snapshot) = content else {
        return Vec::new();
    };
    let mut recent = snapshot
        .text
        .lines()
        .rev()
        .filter_map(|line| {
            let record: Value = serde_json::from_str(line).ok()?;
            let text = record_text(&record)?;
            let text = text.trim();
            if text.is_empty() {
                return None;
            }
            let speaker = match record
                .get("role")
                .or_else(|| record.get("type"))
                .and_then(Value::as_str)
            {
                Some("user") => "用户",
                Some("assistant") => "助手",
                _ => "记录",
            };
            Some(json!({ "speaker": speaker, "text": text.chars().take(240).collect::<String>() }))
        })
        .take(6)
        .collect::<Vec<_>>();
    recent.reverse();
    recent
}

fn record_text(record: &Value) -> Option<String> {
    match record {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let parts = items.iter().filter_map(record_text).collect::<Vec<_>>();
            (!parts.is_empty()).then(|| parts.join(" "))
        }
        Value::Object(fields) => ["text", "content", "message", "parts"]
            .iter()
            .find_map(|key| fields.get(*key).and_then(record_text)),
        _ => None,
    }
}

fn content_state_name(content: &ContentState) -> &'static str {
    match content {
        ContentState::Ready(_) => "ready",
        ContentState::Missing => "missing",
        ContentState::Unavailable(_) => "unavailable",
    }
}

fn summary_text(status: &str) -> &'static str {
    match status {
        "latest" => "关联副本内容一致",
        "behind" => "有副本落后，可安全同步",
        "diverge" => "多个副本有不同更新，需要选择来源",
        "missing" => "有副本内容缺失",
        _ => "暂时无法确认副本状态",
    }
}

fn basename(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::session_link::{
        full_digest_of, normalize_jsonl, ContentSnapshot, SyncMode,
    };

    #[test]
    fn restart_only_when_running_client_may_be_using_write_target() {
        assert!(should_restart_running_target(
            true,
            Some("target"),
            "target"
        ));
        assert!(!should_restart_running_target(
            true,
            Some("other"),
            "target"
        ));
        assert!(should_restart_running_target(true, None, "target"));
        assert!(!should_restart_running_target(
            false,
            Some("target"),
            "target"
        ));
    }

    #[test]
    fn explicit_group_unify_mode_reaches_sync_kernel() {
        let selection = parse_selection("group", "token", "unifyOverwrite").unwrap();
        assert_eq!(selection.mode, SyncMode::UnifyOverwrite);
        assert!(parse_selection("group", "token", "unsupported").is_err());
    }

    fn member_view(
        member_id: &str,
        account_key: &str,
        state: MemberState,
        content: ContentState,
    ) -> MemberView {
        MemberView {
            member: LinkMember {
                member_id: member_id.to_string(),
                account_id: Some(account_key.to_string()),
                uid: format!("uid-{member_id}"),
                session_id: format!("session-{member_id}"),
                variant: Some(WbVariant::Cn),
                state,
                linked_at: 0,
                last_synced_at: None,
            },
            account_key: account_key.to_string(),
            account_name: account_key.to_string(),
            title: member_id.to_string(),
            project_label: String::new(),
            updated_at: 0,
            content,
            reason: String::new(),
            version_status: "unknown",
        }
    }

    fn ready_content(member_id: &str) -> ContentState {
        let text = format!(r#"{{"id":"{member_id}"}}"#);
        ContentState::Ready(ContentSnapshot {
            full_digest: full_digest_of(text.as_bytes()),
            normalized: normalize_jsonl(&text, &format!("session-{member_id}")).unwrap(),
            text,
        })
    }

    fn ready_lines(ids: &[&str]) -> ContentState {
        let text = ids
            .iter()
            .map(|id| format!(r#"{{"id":"{id}"}}"#))
            .collect::<Vec<_>>()
            .join("\n");
        ContentState::Ready(ContentSnapshot {
            full_digest: full_digest_of(text.as_bytes()),
            normalized: normalize_jsonl(&text, "unrelated-session-id").unwrap(),
            text,
        })
    }

    fn active_indexes(views: &[MemberView]) -> Vec<usize> {
        views
            .iter()
            .enumerate()
            .filter(|(_, view)| view.member.state == MemberState::Active)
            .map(|(index, _)| index)
            .collect()
    }

    fn pair(
        matrix: &mut HashMap<(usize, usize), (SyncVerdict, String)>,
        source: usize,
        target: usize,
        verdict: SyncVerdict,
    ) {
        matrix.insert((source, target), (verdict, format!("{verdict:?}")));
    }

    #[test]
    fn client_namespaces_and_scope_are_explicit() {
        assert_eq!(
            SessionClient::parse("workbuddy")
                .unwrap()
                .store_paths()
                .link_namespace,
            crate::modules::session::LinkNamespace::WorkBuddy
        );
        assert!(SessionClient::parse("CodeBuddy").is_err());
        assert!(SessionClient::Workbuddy
            .validate_scope(Some(WbVariant::Ai))
            .is_err());
        assert!(SessionClient::CodebuddyIde.validate_scope(None).is_err());
        assert!(SessionClient::CodebuddyIde
            .validate_scope(Some(WbVariant::Ai))
            .is_ok());
    }

    #[test]
    fn plugin_accepts_both_regions_while_ide_requires_matching_region() {
        for variant in [WbVariant::Cn, WbVariant::Ai] {
            let target = json!({ "uid": "target", "variant": variant.as_str() });
            assert!(validate_target_compatibility(SessionClient::VscodeExt, None, &target).is_ok());
            for scope in [WbVariant::Cn, WbVariant::Ai] {
                assert_eq!(
                    validate_target_compatibility(
                        SessionClient::CodebuddyIde,
                        Some(scope),
                        &target
                    )
                    .is_ok(),
                    scope == variant
                );
            }
        }
    }

    #[test]
    fn workspace_label_never_exposes_or_guesses_a_path() {
        assert_eq!(basename("C:\\users\\private\\project"), "project");
        assert_eq!(basename("/users/private/project/"), "project");
    }

    /// TempDir + injected store root: link-store tests must never touch the real `~/.wb-switch`.
    struct TempStore {
        dir: PathBuf,
        paths: SessionPaths,
    }

    impl TempStore {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "wb_switch_groups_{}_{name}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let paths = SessionPaths {
                store_root: dir.join("store"),
                data_root: dir.join("data"),
                auth_file: dir.join("auth.info"),
                link_namespace: crate::modules::session::LinkNamespace::WorkBuddy,
            };
            std::fs::create_dir_all(&paths.store_root).unwrap();
            Self { dir, paths }
        }

        fn seed(&self, groups: Vec<LinkGroup>) {
            let store = crate::modules::session_link::LinkStore {
                version: crate::modules::session_link::LINK_STORE_VERSION,
                revision: 1,
                groups,
            };
            std::fs::write(
                self.paths.session_links_file(),
                serde_json::to_string_pretty(&store).unwrap(),
            )
            .unwrap();
        }

        fn store(&self) -> crate::modules::session_link::LinkStore {
            match session_link::load_store(&self.paths) {
                StoreState::Ready(store) => store,
                other => panic!("存储应为可读状态：{other:?}"),
            }
        }
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn stored_member(member_id: &str, uid: &str, state: MemberState) -> LinkMember {
        LinkMember {
            member_id: member_id.to_string(),
            account_id: Some(format!("account-{uid}")),
            uid: uid.to_string(),
            session_id: format!("session-{uid}"),
            variant: Some(WbVariant::Cn),
            state,
            linked_at: 1,
            last_synced_at: None,
        }
    }

    fn remove_member_at(paths: &SessionPaths, group_id: &str, member_id: &str) -> Value {
        let (group_removed, remaining) = session_link::with_link_store_write(paths, |store| {
            super::remove_member_in(store, SessionClient::Workbuddy, None, group_id, member_id)
        })
        .unwrap();
        json!({
            "status": if group_removed { "groupRemoved" } else { "removed" },
            "remaining": remaining,
        })
    }

    #[test]
    fn removing_a_member_drops_its_pair_bases_and_keeps_the_rest() {
        let store = TempStore::new("remove-member");
        let mut group = LinkGroup {
            id: "g-1".to_string(),
            variant: WbVariant::Cn,
            created_at: 1,
            members: vec![
                stored_member("m-a", "uid-a", MemberState::Active),
                stored_member("m-b", "uid-b", MemberState::Active),
                stored_member("m-c", "uid-c", MemberState::Stale),
            ],
            pair_bases: Vec::new(),
        };
        for (left, right, ref_name) in [
            ("m-a", "m-b", "base-ab"),
            ("m-a", "m-c", "base-ac"),
            ("m-b", "m-c", "base-bc"),
        ] {
            let (first, second) = session_link::pair_key(left, right);
            group
                .pair_bases
                .push(crate::modules::session_link::PairBase {
                    member_ids: [first, second],
                    baseline_ref: ref_name.to_string(),
                    normalization_version: 1,
                });
        }
        store.seed(vec![group]);

        let result = remove_member_at(&store.paths, "g-1", "m-a");

        assert_eq!(result["status"], "removed");
        assert_eq!(result["remaining"], 2);
        let saved = store.store();
        assert_eq!(saved.groups.len(), 1);
        let members = &saved.groups[0].members;
        assert_eq!(members.len(), 2);
        assert!(members.iter().all(|member| member.member_id != "m-a"));
        let refs = saved.groups[0]
            .pair_bases
            .iter()
            .map(|pair| pair.baseline_ref.as_str())
            .collect::<Vec<_>>();
        assert_eq!(refs, vec!["base-bc"]);
        assert_eq!(saved.revision, 2);
        assert!(session_link::validate_store(&saved).is_ok());
    }

    #[test]
    fn removing_a_superseded_member_keeps_the_group() {
        // 共同旧版 / 已替代成员同样可移除：组保留，remaining 是剩余人数，引用它的配对基线被清掉。
        let store = TempStore::new("remove-superseded");
        let mut group = LinkGroup {
            id: "g-1".to_string(),
            variant: WbVariant::Cn,
            created_at: 1,
            members: vec![
                stored_member("m-a", "uid-a", MemberState::Active),
                stored_member("m-b", "uid-b", MemberState::Active),
                stored_member("m-old", "uid-old", MemberState::Superseded),
            ],
            pair_bases: Vec::new(),
        };
        for (left, right, ref_name) in [
            ("m-a", "m-b", "base-ab"),
            ("m-a", "m-old", "base-a-old"),
            ("m-b", "m-old", "base-b-old"),
        ] {
            let (first, second) = session_link::pair_key(left, right);
            group
                .pair_bases
                .push(crate::modules::session_link::PairBase {
                    member_ids: [first, second],
                    baseline_ref: ref_name.to_string(),
                    normalization_version: 1,
                });
        }
        store.seed(vec![group]);

        let result = remove_member_at(&store.paths, "g-1", "m-old");

        assert_eq!(result["status"], "removed");
        assert_eq!(result["remaining"], 2);
        let saved = store.store();
        assert_eq!(saved.groups.len(), 1);
        assert_eq!(saved.groups[0].id, "g-1");
        assert!(saved.groups[0]
            .members
            .iter()
            .all(|member| member.member_id != "m-old"));
        let refs = saved.groups[0]
            .pair_bases
            .iter()
            .map(|pair| pair.baseline_ref.as_str())
            .collect::<Vec<_>>();
        assert_eq!(refs, vec!["base-ab"]);
        assert!(session_link::validate_store(&saved).is_ok());
    }

    #[test]
    fn removing_the_last_member_deletes_the_group() {
        let store = TempStore::new("remove-last");
        store.seed(vec![
            LinkGroup {
                id: "g-1".to_string(),
                variant: WbVariant::Cn,
                created_at: 1,
                members: vec![stored_member("m-a", "uid-a", MemberState::Active)],
                pair_bases: Vec::new(),
            },
            LinkGroup {
                id: "g-2".to_string(),
                variant: WbVariant::Cn,
                created_at: 1,
                members: vec![stored_member("m-z", "uid-z", MemberState::Active)],
                pair_bases: Vec::new(),
            },
        ]);

        let result = remove_member_at(&store.paths, "g-1", "m-a");

        assert_eq!(result["status"], "groupRemoved");
        assert_eq!(result["remaining"], 0);
        let saved = store.store();
        assert_eq!(saved.groups.len(), 1);
        assert_eq!(saved.groups[0].id, "g-2");
        assert_eq!(saved.revision, 2);
        assert!(session_link::validate_store(&saved).is_ok());
    }

    #[test]
    fn removing_an_unknown_group_or_member_reports_a_readable_error() {
        let store = TempStore::new("remove-unknown");
        store.seed(vec![LinkGroup {
            id: "g-1".to_string(),
            variant: WbVariant::Cn,
            created_at: 1,
            members: vec![stored_member("m-a", "uid-a", MemberState::Active)],
            pair_bases: Vec::new(),
        }]);

        let missing_group = session_link::with_link_store_write(&store.paths, |link_store| {
            super::remove_member_in(link_store, SessionClient::Workbuddy, None, "missing", "m-a")
        })
        .unwrap_err();
        assert_eq!(missing_group, "会话关联组不存在或不属于当前客户端");

        let missing_member = session_link::with_link_store_write(&store.paths, |link_store| {
            super::remove_member_in(link_store, SessionClient::Workbuddy, None, "g-1", "nope")
        })
        .unwrap_err();
        assert_eq!(missing_member, "成员不存在，请刷新后重试");

        // 失败的读改写不得落盘，更不得推进 revision。
        let saved = store.store();
        assert_eq!(saved.revision, 1);
        assert_eq!(saved.groups[0].members.len(), 1);
        assert!(session_link::validate_store(&saved).is_ok());
    }

    #[test]
    fn unlink_rejects_invalid_scope_combinations() {
        let vscode =
            remove_member(SessionClient::VscodeExt, Some(WbVariant::Ai), "g-1", "m-a").unwrap_err();
        assert!(vscode.contains("只有 CodeBuddy IDE"));
        let workbuddy =
            remove_member(SessionClient::Workbuddy, Some(WbVariant::Cn), "g-1", "m-a").unwrap_err();
        assert!(workbuddy.contains("只有 CodeBuddy IDE"));
        let ide = remove_member(SessionClient::CodebuddyIde, None, "g-1", "m-a").unwrap_err();
        assert!(ide.contains("必须指定 cn 或 ai"));
    }

    #[test]
    fn aggregate_selects_a_safe_dominant_source_and_marks_only_fast_forward_targets_behind() {
        let mut views = vec![
            member_view(
                "source",
                "account-a",
                MemberState::Active,
                ready_content("a"),
            ),
            member_view(
                "behind",
                "account-b",
                MemberState::Active,
                ready_content("b"),
            ),
        ];
        let mut matrix = HashMap::new();
        pair(&mut matrix, 0, 1, SyncVerdict::FastForward);
        pair(&mut matrix, 1, 0, SyncVerdict::Ahead);

        let active = active_indexes(&views);
        let (safe_source, summary) = aggregate_group_state(&mut views, &active, &matrix);

        assert_eq!(safe_source, Some(0));
        assert_eq!(summary, "behind");
        assert_eq!(views[0].version_status, "latest");
        assert_eq!(views[1].version_status, "behind");
    }

    #[test]
    fn aggregate_keeps_equal_latest_copies_and_uses_stable_account_order_for_operations() {
        // Input order differs from the stable account ordering on purpose.
        let mut views = vec![
            member_view(
                "latest-z",
                "account-z",
                MemberState::Active,
                ready_content("z"),
            ),
            member_view(
                "latest-a",
                "account-a",
                MemberState::Active,
                ready_content("a"),
            ),
            member_view(
                "behind",
                "account-m",
                MemberState::Active,
                ready_content("m"),
            ),
        ];
        let mut matrix = HashMap::new();
        for (source, target, verdict) in [
            (0, 1, SyncVerdict::Identical),
            (1, 0, SyncVerdict::Identical),
            (0, 2, SyncVerdict::FastForward),
            (1, 2, SyncVerdict::FastForward),
            (2, 0, SyncVerdict::Ahead),
            (2, 1, SyncVerdict::Ahead),
        ] {
            pair(&mut matrix, source, target, verdict);
        }

        let active = active_indexes(&views);
        let (safe_source, summary) = aggregate_group_state(&mut views, &active, &matrix);

        assert_eq!(safe_source, Some(1));
        assert_eq!(views[0].version_status, "latest");
        assert_eq!(views[1].version_status, "latest");
        assert_eq!(views[2].version_status, "behind");
        assert_eq!(summary, "behind");
    }

    #[test]
    fn aggregate_reports_divergence_without_inventing_a_safe_source() {
        let mut views = vec![
            member_view("a", "account-a", MemberState::Active, ready_content("a")),
            member_view("b", "account-b", MemberState::Active, ready_content("b")),
        ];
        let mut matrix = HashMap::new();
        pair(&mut matrix, 0, 1, SyncVerdict::Diverge);
        pair(&mut matrix, 1, 0, SyncVerdict::Diverge);

        let active = active_indexes(&views);
        let (safe_source, summary) = aggregate_group_state(&mut views, &active, &matrix);

        assert_eq!(safe_source, None);
        assert_eq!(summary, "diverge");
        assert_eq!(views[0].version_status, "diverge");
        assert_eq!(views[1].version_status, "diverge");
    }

    #[test]
    fn recognizes_three_equal_old_copies_and_two_independent_extensions() {
        let views = vec![
            member_view("old-a", "a", MemberState::Active, ready_lines(&["base"])),
            member_view(
                "tip-a",
                "b",
                MemberState::Active,
                ready_lines(&["base", "alice"]),
            ),
            member_view("old-b", "c", MemberState::Active, ready_lines(&["base"])),
            member_view(
                "tip-b",
                "d",
                MemberState::Active,
                ready_lines(&["base", "bob"]),
            ),
            member_view("old-c", "e", MemberState::Active, ready_lines(&["base"])),
        ];
        assert_eq!(
            common_base_branches(&views, &active_indexes(&views)),
            Some(CommonBaseBranches {
                common: vec![0, 2, 4],
                branches: vec![vec![1], vec![3]]
            })
        );
    }

    #[test]
    fn does_not_call_a_linear_history_independent_branches() {
        let views = vec![
            member_view("old", "a", MemberState::Active, ready_lines(&["base"])),
            member_view(
                "mid",
                "b",
                MemberState::Active,
                ready_lines(&["base", "alice"]),
            ),
            member_view(
                "new",
                "c",
                MemberState::Active,
                ready_lines(&["base", "alice", "bob"]),
            ),
        ];
        assert_eq!(common_base_branches(&views, &active_indexes(&views)), None);
    }

    #[test]
    fn aggregate_keeps_unknown_and_missing_distinct() {
        let mut unknown_views = vec![
            member_view("a", "account-a", MemberState::Active, ready_content("a")),
            member_view(
                "unknown",
                "account-b",
                MemberState::Active,
                ContentState::Unavailable("正文读取失败".to_string()),
            ),
        ];
        let mut unknown_matrix = HashMap::new();
        pair(&mut unknown_matrix, 0, 1, SyncVerdict::Unknown);
        pair(&mut unknown_matrix, 1, 0, SyncVerdict::Unknown);
        let active = active_indexes(&unknown_views);
        let (safe_source, summary) =
            aggregate_group_state(&mut unknown_views, &active, &unknown_matrix);
        assert_eq!(safe_source, None);
        assert_eq!(summary, "unknown");
        assert_eq!(unknown_views[1].version_status, "unknown");

        let mut missing_views = vec![
            member_view("a", "account-a", MemberState::Active, ready_content("a")),
            member_view(
                "missing",
                "account-b",
                MemberState::Active,
                ContentState::Missing,
            ),
        ];
        let mut missing_matrix = HashMap::new();
        pair(&mut missing_matrix, 0, 1, SyncVerdict::Unknown);
        pair(&mut missing_matrix, 1, 0, SyncVerdict::Unknown);
        let active = active_indexes(&missing_views);
        let (safe_source, summary) =
            aggregate_group_state(&mut missing_views, &active, &missing_matrix);
        assert_eq!(safe_source, None);
        assert_eq!(summary, "missing");
        assert_eq!(missing_views[1].version_status, "missing");
    }

    #[test]
    fn aggregate_preserves_stale_and_superseded_members_outside_active_source_selection() {
        let mut views = vec![
            member_view(
                "source",
                "account-a",
                MemberState::Active,
                ready_content("a"),
            ),
            member_view(
                "behind",
                "account-b",
                MemberState::Active,
                ready_content("b"),
            ),
            member_view(
                "stale",
                "account-c",
                MemberState::Stale,
                ContentState::Missing,
            ),
            member_view(
                "superseded",
                "account-d",
                MemberState::Superseded,
                ContentState::Missing,
            ),
        ];
        let mut matrix = HashMap::new();
        pair(&mut matrix, 0, 1, SyncVerdict::FastForward);
        pair(&mut matrix, 1, 0, SyncVerdict::Ahead);

        let active = active_indexes(&views);
        let (safe_source, summary) = aggregate_group_state(&mut views, &active, &matrix);

        assert_eq!(safe_source, Some(0));
        assert_eq!(summary, "behind");
        assert_eq!(views[2].version_status, "stale");
        assert_eq!(views[3].version_status, "superseded");
    }
}
