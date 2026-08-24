# PolyMirror 长期盈利质量盯盘 memory

## 2026-07-14 18:59–19:18 CST

- 通过 SSM 获取并释放 `/tmp/polymirror-17-21.lock`，无重叠；实例/SSM 在线。
- 端口：8081/8082/8084 HTTP 可达但因预期控制态为 degraded；8083 连续 3 次、每次 20 秒超时，按降级报告处理。所有可读端口均 previewMode=true、pending=0、walletDrifts=[]、settlementFailures=0、closedMarketOpenPositions=0、lastError=null、capacityStatus=OK。
- 8084 固定 tag f55b91678f4da0b9496b7ffcb14011eaeecb69ae，对应 image ID sha256:c0b481fe...；optimizer6 已运行约 29h，原生 collector 报告 2026-07-14T10:37:27Z。
- optimizer6 六臂原生 planPreviewEvolution 全部 retire。10% dance arm：REDEEM=10、PnL=-28.8656U、PF=0.56、报告回撤24.14%、健康清算回撤23.6958%，触发 >=15% 硬淘汰。
- 已对 10% dance arm 做 WAL-safe Python sqlite3.backup + quick_check + SHA256，再用项目 StateStore.setExperimentControl 转 SETTLE_ONLY/USER_STRATEGY_REJECTED；SELL/REDEEM 保留。备份目录 `/opt/polymirror/cohorts/optimizer6-20260713-v1/data/maintenance-retire-20260714T110806Z-exp_optimizer6_v1_dance_candidate_pct10_age3m_slip2_5_200`。config SHA=6891dc77..., DB SHA=82929d57..., control audit SHA=6dce4980...。最终 8084 仅 0.5% dance control ACTIVE，其余 SETTLE_ONLY。
- fresh profit intake v4 captured 2026-07-14T11:15:17Z：4 个全部失败。crypto68 SHA=56c4c15d...，24h trades=38、exit=2、conditions=2、P90=730.5058U；失败 exit/广度/P90 门槛，旧 v3 资格不得用于部署。canonical approved cohort SHA=6d73e20f...。
- fresh cluster intake v4 captured 2026-07-14T11:16:00Z：balthazar 3937 trades/1567 exits/1135 conditions，但最近50完整盈利口径胜率46%，失败；corlys 新通过 intake（7095 trades/1149 exits/2549 conditions，50仓 +1175.60U、胜率86%、PF387.54、去最大盈利+982.12U），证据 SHA=c387e61a...，但仅 watchlist，尚无 source-price stress 与真实 preview 退出证据，禁止生成/部署实验。
- 本轮无新模拟盘、无实盘。opt7 crypto68 因 fresh intake 失败关闭；balthazar 不部署；corlys 仅 watchlist。
- 磁盘最终可用 44,973,899,776 bytes（约41.9GiB/45.0GB）；整机保守下降约111.4MB/h，预计约16.8天，未触发15GB/10GB门槛。
- 最佳已实现：b55 strict 2% +6.17U（8 REDEEM，PF2.17，样本不足）；dance mid 10% +3.06U（5 REDEEM，PF1.33，高度集中）。最差：quality b55 aggressive -40.29U；optimizer6 b55 timing -32.91U；无可审核实盘档。
- 下一轮只做：fresh intake/watchlist 复核及现有 ACTIVE 0.5% dance 的继续结算观察；不部署 opt7，除非 crypto68 重新通过完整 intake；corlys 必须先完成原生 copyability 与真实 preview 退出证据。

Artifacts:
- `/Users/kaijimima1234/.codex/automations/polymirror-17-21/artifacts/candidate-intake-profit-v4-20260714T1915`
- `/Users/kaijimima1234/.codex/automations/polymirror-17-21/artifacts/candidate-intake-cluster-v4-20260714T1916`

Current run time: 2026-07-14 19:18 CST (about 19 minutes).

## 2026-07-15 13:56 CST

- 使用项目原生 `refresh-candidate-intake.mts` 对 leaderboard19 全 cohort 做 fresh 刷新；`badatmath` 当前不再通过 intake，禁止部署。
- `badatmath` fresh 数据：5241 trades / 80 exits / 469 conditions；50 个盈利口径仓位，PnL +2200.88911U，PF 17.23788，去最大盈利 +1607.017613U，最大盈利占 25.42%，无 API error、无 unreconciled resolved position；但胜率 48%（24胜26负）低于原生 50% 门槛，唯一失败项 `profitabilityWinRate`。
- fresh evidence SHA256：`a66612c873ec0d4dfe87344f10b73588dc84e9c2359c7f7c009cf654c6d9ed13`；artifact：`candidate-refresh-badatmath-20260715T055639Z`。
- 首次 SSM 调用因参数编码失败、第二次因已有自动化持锁而 fail closed；第三次已获取锁并运行 8081–8085 健康检查及 8085 原生 collector，CommandId `590d4268-aa92-43fe-bde3-6e4ee72fda38`，当前仍 InProgress，未做部署、停买或参数变更。
- 下一步：读取该 SSM 完成结果，按 cryptofb1c 满 24h 后的真实 REDEEM/PnL/PF/回撤作整组保留或 SETTLE_ONLY 决策；badatmath 只有重新通过 fresh intake 后才可重跑回放并进入部署门禁。

## 2026-07-15 14:00–14:09 CST

- SSM audit `590d4268-aa92-43fe-bde3-6e4ee72fda38` 成功。8085 原生 collector 报告 `preview-report-2026-07-15T06-00-07-813Z.json`：观察 0.72 天，尚未满 24h。
- cryptofb1c 1U：11 COPY/11 REDEEM，realized PnL -4.66U，2胜9负，PF 0.48，Sharpe -1.10，最大回撤 3.97%，Cash 195.3313U，OpenCost 0，仍 ACTIVE；按规则满 24h 前不因普通亏损调参。
- cryptofb1c 2U：20 REDEEM，PnL -8.93U，PF 0.70，回撤 8.97%；5U：4 REDEEM，PnL -13.68U，PF 0.09，回撤 7.50%。两者已由日亏损安全阈值自动转 SETTLE_ONLY。
- `badatmath` fresh intake 失败后，对同 cohort 四个 fresh 通过候选重跑 1 日完整回放：全部不足 10 个 unique officially settled condition；shyguy1/shamu 盈利集中且去最大盈利转负，全部淘汰，无部署。
- 新 official leaderboard scan20 覆盖 WEATHER/ECONOMICS/POLITICS/SPORTS，严格排除历史 seed，fresh intake 10 个新候选，3 个通过：weather20_2、politics20_7、politics20_8。三者完整 1 日回放最多仅 1 个结算，全部淘汰。scan SHA `1787face...`，manifest SHA `a6c5e36a...`；回放 SHA 分别 `080166a5...`、`50f8e3d1...`、`e4f6e946...`。
- 安全审计发现 8082 `exp_dance_scaled_pct1_200` ACTIVE 且清算回撤 37.20%，触发 >=15% 硬淘汰。完成 WAL-safe sqlite backup/quick_check，SHA `922fe408...`，再用项目 StateStore 转 SETTLE_ONLY/USER_STRATEGY_REJECTED；健康复核 pending=0、walletDrifts=[]、settlementFailures=0，保留 SELL/REDEEM。备份目录 `/opt/polymirror/cohorts/dance-ab-20260712/data/maintenance-retire-20260715T060710Z-exp_dance_scaled_pct1_200`。
- 8084 最后 ACTIVE `exp_optimizer6_v1_dance_control_pct0_5_age6m_slip4_200` 清算回撤 26.00%，同样完成备份 SHA `940159c6...` 并转 SETTLE_ONLY/USER_STRATEGY_REJECTED；健康复核通过，备份目录 `/opt/polymirror/cohorts/optimizer6-20260713-v1/data/maintenance-retire-20260715T060821Z-exp_optimizer6_v1_dance_control_pct0_5_age6m_slip4_200`。
- 当前可确认的新买 ACTIVE 仅 cryptofb1c 1U；8081 健康仍超时，历史定位不变。无新部署、无实盘。
- 下一步：cryptofb1c 到 2026-07-15 20:49 CST 满 24h 后立即跑 collector；若仍无正向证据，将 1U 转 SETTLE_ONLY。继续扫描新候选，但只有 fresh intake + >=10 官方结算 + PF/集中度全部通过才部署。
- scan21 再 intake 10 个历史 seed 未见候选，仅 SPORTS `sports21_10`（BreakTheBank）通过 fresh intake：2053 trades / 410 exits / 15 conditions，盈利口径 +5.174M U、胜率71.93%、PF4.88；但 1 日完整跟单回放 1U/2U/5U 仅4/5/4个结算，PnL分别 -23.85/-25.37/-23.75U，PF 0/0.25/0.21，全部淘汰。manifest SHA `ad87e877...`，replay SHA `cf36fb1b...`。

## 2026-07-15 14:11–14:13 CST

- 再次核验 8082/8084/8085：preview-only，pending=0，walletDrifts=[]，settlementFailures=0；此前两处硬回撤 ACTIVE 均保持 SETTLE_ONLY。当前唯一可确认 ACTIVE 是 cryptofb1c 1U，回撤2.33%，未满24h。
- scan22 fresh intake 10 个新的历史 seed 未见候选，仅 WEATHER `weather22_2` 通过：85 trades / 22 exits / 12 conditions，盈利口径 +7679.38U、胜率78.85%、PF30.99、无 unreconciled resolved position。
- `weather22_2` 1 日完整 guarded-limit 回放：官方市场返回6个；FIXED 1/2/5 均仅3个结算，全部0胜3负，PnL -18.93/-23.93/-29.97U，PF=0，立即淘汰。manifest SHA `376821c5...`，replay SHA `dadaac60...`。
- 累计本轮新增扫描30个未见候选；无一通过完整部署门禁，无新部署。

## 2026-07-15 14:13–14:15 CST

- scan23 intake 10 个新的历史 seed 未见候选，10/10 均 fresh gate 失败，未进入回放；manifest SHA `284a401e...`。
- scan24 再 intake 10 个，仅 POLITICS `politics24_10`（ProfessionalPunter）通过：41 trades / 26 exits / 6 conditions，盈利口径 +130523.43U、胜率55.10%、PF4.01、无 unreconciled resolved position。
- `politics24_10` 完整1日回放官方返回17个市场，但 FIXED 1/2/5 均0个 officially settled condition，无法形成结算证据，淘汰。manifest SHA `dd4503af...`，replay SHA `c8ec50b9...`。
- 本轮累计新增扫描50个未见候选，仍无一满足部署门禁；ACTIVE 状态未变，无新部署。

## 2026-07-15 14:15–14:17 CST

- scan25 intake 10 个新的历史 seed 未见候选，全部 fresh gate 失败；manifest SHA `b3bb0df5...`。
- scan26 再 intake 10 个，仅 POLITICS `politics26_6`（881112）通过：91 trades / 30 exits / 28 conditions，盈利口径 +25627.53U、胜率72%、PF3.04、最大盈利占22.42%、无 unreconciled resolved position。
- `politics26_6` 完整1日回放只返回3个官方市场，FIXED 1/2/5 均0个 officially settled condition，淘汰。manifest SHA `f04bae07...`，replay SHA `327a4a4d...`。
- 本轮累计新增扫描70个未见候选，仍无部署合格者；ACTIVE/preview 状态未变。

## 2026-07-15 14:17–14:19 CST

- scan27 intake 10 个新候选，WEATHER `weather27_5`、`weather27_10` 通过。`weather27_5` 回放0结算；`weather27_10` FIXED 1/2/5 仅6/7/5结算，虽 PnL +1.64/+3.19/+16.24U、PF1.33/1.32/2.08，但最大盈利占96%–100%，去最大盈利均为负，淘汰。manifest SHA `9e854c5f...`，replay SHA `df5c570b...` / `852154cc...`。
- scan28 intake 10 个新候选，仅 WEATHER `weather28_6`（0xdelphinium）通过：42 trades / 22 exits / 20 conditions，源盈利口径50胜0负、+28.01U、去最大盈利+24.49U；但完整回放 FIXED 1/2/5 均0个 officially settled condition，淘汰。manifest SHA `55b963d9...`，replay SHA `f6d7eefe...`。
- 本轮累计新增扫描90个未见候选，无一满足部署门禁；仍只有 cryptofb1c 1U ACTIVE，未满24h。

## 2026-07-15 14:19–14:22 CST

- scan29 intake 10 个新候选，仅 `weather29_2` 通过；完整回放 FIXED 1/2/5 仅1/1/3结算且 PnL -0.99/-1.99/-4.32U，PF 0/0/0.13，淘汰。manifest SHA `e87c7b80...`，replay SHA `3c7639a5...`。
- scan30 intake 10 个新候选，`weather30_1`、`politics30_4`、`weather30_7` 通过。官方市场首次请求超时，按 fail-closed 重试成功；三者回放最多仅1个结算，正收益样本也100%依赖单笔，全部淘汰。manifest SHA `ddeaf5d1...`，replay SHA `4474ea9f...` / `a9c38699...` / `037fd79f...`。
- 本轮累计新增扫描110个未见候选，无部署合格者。前向模拟累计已实现净损失仍约 -27.28U；尚未找到可审核盈利方式。

## 2026-07-15 14:22–14:25 CST

- scan31 intake 10 个新候选，仅 WEATHER `weather31_2` 通过；FIXED 5U 回放仅2个结算，+2.03U、2胜0负，但最大盈利占86.13%，样本与集中度均失败；1U/2U无结算。manifest SHA `34f68b83...`，replay SHA `acd8ed0b...`。
- scan32 首次因榜单空 username 触发 schema fail-closed，未产生 evidence；使用地址作为缺失 username 的原样身份标签后重新 intake，10/10 全部 fresh gate 失败，无回放。
- 本轮累计新增扫描130个未见候选，无部署合格者；前向已实现净利润状态未改善，尚未找到。

## 2026-07-15 14:27–14:30 CST

- 重新抓取官方榜单做跨时间复验，fresh snapshot SHA `e45a0f08...`；与14:02快照相比，WEATHER/ECONOMICS/POLITICS/SPORTS 无新入榜地址。
- scan33 intake 10 个剩余未见候选，仅 `weather33_7` 通过，但完整回放三档均0结算，淘汰。manifest SHA `67485b10...`，replay SHA `5b4af34e...`。
- scan34 intake 10 个剩余未见候选，4个通过。回放最多6个结算：`weather34_8` 三档均亏，`weather34_10` 三档均亏且5U触发 kill；其余两者无有效样本或单笔集中，全部淘汰。manifest SHA `399c3400...`，replay SHA `4e678016...` / `797081ac...` / `f0f88f45...` / `5de39c15...`。
- 本轮累计新增扫描150个未见候选；仍无部署合格者，前向已实现利润未改善。

## 2026-07-15 14:30–14:33 CST

- scan35 intake 10 个新候选，2个 WEATHER 通过。回放最多8个结算：`weather35_7` 2U/5U均亏；`weather35_8` 2U +21.66U但仅2结算且100%依赖单笔、去最大盈利为负，5U亏损，全部淘汰。manifest SHA `67d88a4e...`。
- scan36 intake 10 个新候选，SPORTS/ECONOMICS/POLITICS 各1个通过。SPORTS 2U +15.96U/PF1.73但仅6结算、最大盈利占91.46%、去最大盈利为负；POLITICS 5U +6.62U/PF2.32但仅5结算且最大盈利占53.15%；ECONOMICS无结算，全部淘汰。manifest SHA `4bb37ed3...`。
- 本轮累计新增扫描170个未见候选；仍无前向部署资格，已实现净利润未改善。

## 2026-07-15 14:33–14:36 CST

- scan37 intake 10 个新候选，5个通过。首次出现达到10结算的 `weather37_6` 2U，但 PnL -27.70U、2胜8负、PF0.23；其余最多9结算，盈利档高度集中且去最大盈利为负，全部淘汰。manifest SHA `852bf3e4...`。
- scan38 intake 10 个新候选，3个 WEATHER 通过。`weather38_4` 1U/2U 分别11/10结算，但为0胜11负/-38.90U、0胜10负/-38.03U；另两者亏损或无结算，全部淘汰。manifest SHA `ddaf5837...`。
- 本轮累计新增扫描190个未见候选；有足量结算的方案仍显著亏损，无前向部署资格。

## 2026-07-15 14:36–14:39 CST

- scan39 intake 10 个新候选，仅 WEATHER `weather39_2` 通过；三档回放均0结算，淘汰。manifest SHA `4c8c5562...`，replay SHA `9dec74af...`。
- scan40 intake 10 个新候选，仅 ECONOMICS `economics40_1` 通过；1U/2U无结算，5U仅1结算且 -4.44U，淘汰。manifest SHA `a642b8a9...`，replay SHA `41c0715a...`。
- 本轮累计新增扫描210个未见候选；仍无可进入前向模拟的新方案。

## 2026-07-15 14:39–14:42 CST

- scan41 intake 10 个新候选，3个通过。`sports41_7` FIXED5 回放8结算、+8.51U、6胜2负、PF1.85、最大盈利占28.68%、去最大盈利+3.21U，为当前最近门者，但不足10结算，仅 watchlist；另两者样本不足或高度集中。manifest SHA `19c4bb81...`。
- 对 `sports41_7` 扩展2日跨时间回放，仍只有同样8个结算与相同结果，未增加独立样本，继续 watchlist、禁止部署；2d replay SHA `f6d59355...`。
- scan42 intake 10 个新候选，10/10 fresh gate 失败。manifest SHA `21b43e1c...`。
- 本轮累计新增扫描230个未见候选；仍无新前向模拟，当前最接近者也未达到部署样本门槛。

## 2026-07-15 14:42–14:44 CST

- scan43 intake 10 个新候选，2个 WEATHER 通过；一个无结算，另一个三档最多5结算且均亏损/PF<1，淘汰。manifest SHA `4ccd9608...`。
- scan44 intake 10 个新候选，仅 `weather44_7` 通过；FIXED 1/2/5 仅1/5/6结算，PnL -1.00/-9.75/-0.31U，PF0/0.39/0.98，去最大盈利均为负，淘汰。manifest SHA `5b06c6e3...`，replay SHA `c2492ee2...`。
- 本轮累计新增扫描250个未见候选；无新前向模拟资格，SPORTS watchlist 仍仅8结算。

## 2026-07-15 14:44–14:46 CST

- scan45 intake 10 个新候选，2个 WEATHER 通过，但完整回放三档均0结算，淘汰。manifest SHA `21bfae18...`。
- scan46 intake 10 个新候选，10/10 fresh gate 失败，无回放。SPORTS watchlist 仍无新增独立结算。
- 本轮累计新增扫描270个未见候选；优先类别尚余54个地址，仍无新前向模拟资格。

## 2026-07-15 14:46–14:49 CST

- scan47 intake 10 个新候选，仅 `weather47_8` 通过，但三档完整回放均0结算，淘汰。manifest SHA `185c13a8...`。
- scan48 intake 10 个新候选，POLITICS/ECONOMICS/WEATHER 各1个通过。ECONOMICS 三档均仅2结算且100%依赖单笔、去最大盈利为负；其余无结算或亏损，全部淘汰。manifest SHA `27249970...`。
- 本轮累计新增扫描290个未见候选；优先类别剩余34个地址，无新前向模拟资格。

## 2026-07-15 14:49–14:52 CST

- scan49 intake 10 个新候选，仅 `weather49_8` 通过。2U 达到11结算并 +4.74U，但 PF1.195<1.2、最大盈利占51.87%>50%、去最大盈利 -10.31U；严格淘汰。1U亏损，5U仅5结算且集中度失败。manifest SHA `ce4819a3...`，replay SHA `3c238789...`。
- scan50 intake 10 个新候选，10/10 fresh gate 失败，无回放。
- 本轮累计新增扫描310个未见候选；优先类别剩余14个地址，无新前向模拟资格。

## 2026-07-15 14:52–14:56 CST

- scan51 覆盖优先类别10个剩余地址，仅 `weather51_3` 通过但三档0结算；scan52 覆盖最后4个地址，仅 `economics52_3` 通过。其2U达12结算、+7.48U、PF1.27、最大盈利占27.49%，但去最大盈利 -2.25U，严格淘汰。至此当前快照 WEATHER/ECONOMICS/POLITICS/SPORTS 共324个未见地址全部完成 intake。
- 扩展低相关类别 CULTURE/FINANCE/TECH/MENTIONS，scan53 intake 10 个新候选，2个通过；MENTIONS 5U 两结算 -19.99U并触发 kill，CULTURE 无结算，淘汰。manifest SHA `390e0d7f...`。
- 本轮累计新增扫描334个未见候选；无新前向模拟资格，尚未找到已实现盈利方式。

## 2026-07-15 14:56–14:59 CST

- 低相关类别尚有334个未见地址。scan54 intake 10 个，仅 TECH `tech54_5` 通过；2U 达10结算、+13.30U、PF1.60，但最大盈利占55.20%且去最大盈利 -6.21U，淘汰；1U/5U亏损，5U触发 kill。manifest SHA `d9ec657b...`，replay SHA `9b7f883d...`。
- scan55 intake 10 个，仅 MENTIONS `mentions55_2` 通过，但三档回放均0结算，淘汰。manifest SHA `ac445133...`。
- 本轮累计新增扫描354个未见候选；无新前向模拟资格，前向已实现利润未改善。

## 2026-07-15 14:59–15:02 CST

- scan56 intake 10 个低相关候选，仅 MENTIONS `mentions56_3` 通过；5U仅7结算、+1.78U、PF1.18、最大盈利占79.87%、去最大盈利 -7.63U，1U/2U亏损，淘汰。manifest SHA `24935a97...`。
- scan57 intake 10 个低相关候选，仅 MENTIONS `mentions57_8` 通过；三档最多7结算且均亏损，淘汰。manifest SHA `cc4d0c9c...`。
- 本轮累计新增扫描374个未见候选；仍无新前向模拟资格，尚未找到已实现盈利方式。

## 2026-07-15 15:02–15:04 CST

- scan58 intake 10 个低相关候选，10/10 fresh gate 失败，无回放。manifest SHA `2e072af7...`。
- scan59 intake 10 个低相关候选，仅 MENTIONS `mentions59_8` 通过；三档均仅1结算且全部亏损，淘汰。manifest SHA `b1cce88c...`，replay SHA `0f67109d...`。
- 本轮累计新增扫描394个未见候选；无新前向模拟资格，已实现利润未改善。

## 2026-07-15 15:04–15:06 CST

- scan60 intake 10 个低相关候选，10/10 fresh gate 失败，无回放。manifest SHA `c85c2ce3...`。
- scan61 intake 10 个低相关候选，仅 MENTIONS `mentions61_6` 通过；1U/2U无结算，5U仅1结算且收益0.01U、100%单笔依赖，淘汰。manifest SHA `06a746cd...`，replay SHA `2dc7749d...`。
- 本轮累计新增扫描414个未见候选；仍无新前向模拟资格，尚未找到已实现盈利方式。

## 2026-07-15 15:06–15:10 CST

- scan62 intake 10 个低相关候选，MENTIONS 与 FINANCE 各1个通过。MENTIONS 仅5结算、+5.04U，样本不足；FINANCE 三档均0结算，均不进入前向模拟。manifest SHA `f7476f45...`。
- scan63 intake 10 个低相关候选，5个通过。三者0结算；`culture63_6` 各档均亏；`mentions63_9` 5U虽6胜1负但净亏 -8.49U、PF0.15且盈利集中，全部淘汰。manifest SHA `71df3524...`。
- 本轮累计新增扫描434个未见候选；仍无新前向模拟资格，尚未找到已实现盈利方式。

## 2026-07-15 15:02–15:06 CST（前向淘汰与 scan64–65）

- 8085 前向组最新合计36次 REDEEM、已实现 -28.27U；1U/2U/5U 分别 -5.65/-8.93/-13.68U。最后 ACTIVE 的1U仅2胜10负、PF0.43，profitability gate=reject；先做 WAL-safe 备份（SHA `fa7e95c1...`），再转 SETTLE_ONLY/USER_STRATEGY_REJECTED。复核三档均停止新增买入，pending=0、walletDrifts=[]、settlementFailures=0、preview=true；1U剩1U open cost，待结算后删除失败实验。
- scan64 intake 10 个低相关新候选，0个通过 fresh gate。manifest SHA `d524bf71...`。
- scan65 intake 10 个低相关新候选，仅 `mentions65_6` 通过；1U/2U/5U仅1/2/3结算且全部亏损（-1.98/-7.99/-29.99U），淘汰。manifest SHA `00c88f6f...`，replay SHA `ba0ca26b...`。
- 本轮累计新增扫描454个未见候选；ACTIVE 新买账户为0，尚未找到已实现盈利方式。

## 2026-07-15 15:06–15:13 CST

- scan66 intake 10 个低相关新候选，仅 `mentions66_6` 通过；1U/2U/5U 回放均亏（-6.98/-13.96/-8.54U），5U 最大盈利占78.37%且去最大盈利 -11.13U，淘汰。manifest SHA `c20942f2...`，replay SHA `32eb6830...`。
- scan67 intake 10 个低相关新候选，0个通过 fresh gate。manifest SHA `4ababb9a...`。
- cryptofb 2U/5U 已确认0持仓、0挂单、0意图、0未解决结算故障；完成可复现 DB/config 归档后从运行集合禁用。归档目录 `retired-cleared-20260715T071229Z`，DB SHA `d2dfaa1c...`/`4c115c60...`。健康复核仅剩1U SETTLE_ONLY，preview=true、pending=0、walletDrifts=[]、settlementFailures=0；ACTIVE 新买账户仍为0。
- 本轮累计新增扫描474个未见候选；尚未找到已实现盈利方式。

## 2026-07-15 15:13–15:17 CST

- scan68 intake 10 个低相关新候选，3个通过。`tech68_6` 1U/2U 均12结算且 +10.63/+21.37U、PF2.06，但仅2胜10负，最大盈利占55%且去最大盈利 -0.76/-1.53U，明确为少数大赢驱动；其余候选亏损，全部淘汰。manifest SHA `0e003574...`。
- scan69、scan70 各 intake 10 个新候选，均0个通过 fresh gate。manifest SHA `2cbfae2b...`/`c9a4fa44...`。
- scan71 intake 10 个新候选，3个通过；一个仅单笔盈利且100%依赖该笔，一个单笔亏损，一个0结算，全部淘汰。manifest SHA `eb183cf6...`。
- cryptofb 1U 仍为 SETTLE_ONLY，剩1持仓/1U成本，0挂单、0意图、0结算故障；未提前删除。ACTIVE 新买账户为0。
- 本轮累计新增扫描514个未见候选；尚未找到已实现盈利方式。

## 2026-07-15 15:17–15:20 CST

- scan72 intake 10 个新候选，3个 FINANCE 通过；盈利档最多仅4结算、PF1.36且去最大盈利 -0.66U，其余亏损/0结算，全部淘汰。manifest SHA `5715be75...`。
- scan73 intake 10 个新候选，0个通过。manifest SHA `34ae2e65...`。
- scan74 intake 10 个新候选，2个通过。`mentions74_10` 5U 为5结算全胜、+1.29U、最大盈利占33.09%、去最大盈利+0.86U，是本批最强但样本不足；扩展2日回放仍仅相同5结算，保留 watchlist、禁止部署。manifest SHA `393aa931...`，2d replay SHA `ff1c415b...`。另一候选亏损。
- scan75 intake 10 个新候选，仅 TECH 通过但三档0结算，淘汰。manifest SHA `19e72bc...`。
- 本轮累计新增扫描554个未见候选；ACTIVE 新买账户为0，尚未找到已实现盈利方式。

## 2026-07-15 15:20–15:22 CST

- scan76 intake 10 个新候选，仅 CULTURE 通过。2U/5U 仅4结算、+5.84/+14.64U、PF2.47、去最大盈利仍小幅为正，但胜率50%、最大盈利占54%且样本不足，未部署。manifest SHA `e108094d...`。
- scan77 intake 10 个新候选，仅 FINANCE 通过；盈利档仅1胜3负且100%依赖单笔、去最大盈利 -9.97U，淘汰。manifest SHA `db14c623...`。
- scan78 intake 10 个新候选，0个通过。manifest SHA `074b1644...`。
- scan79 intake 10 个新候选，2个通过；一个仅2结算盈利且最大盈利占58%，另一个亏损，均淘汰。manifest SHA `a2c4ba07...`。
- 本轮累计新增扫描594个未见候选；ACTIVE 新买账户为0，尚未找到已实现盈利方式。

## 2026-07-15 15:22–15:25 CST

- scan80 intake 10 个新候选，2个通过但回放仅0–1结算且亏损，淘汰。manifest SHA `2304edf7...`。
- scan81 intake 10 个新候选，2个通过。`culture81_2` 5U 在1日证据中6结算、5胜1负、+9.88U、PF2.98、最大盈利占32.98%、去最大盈利+4.97U；但2日跨时间重取未复现任何结算样本，判定时间外证据失败，不部署。另一候选仅单笔盈利。manifest SHA `e814536f...`，2d replay SHA `87ccefad...`。
- scan82 intake 10 个新候选，仅 CULTURE 通过但三档均亏，淘汰。manifest SHA `8d323cc9...`。
- scan83 intake 10 个新候选，3个通过；一个0结算，两个均亏且盈利集中，全部淘汰。manifest SHA `ae3e2acf...`。
- 本轮累计新增扫描634个未见候选；当前快照低相关类别剩44个未见地址，ACTIVE 新买账户为0，尚未找到已实现盈利方式。

## 2026-07-15 15:25–15:31 CST

- scan84 intake 10 个新候选，仅 MENTIONS 通过但三档均亏；scan85 10/10 fresh gate 失败；scan86 仅 MENTIONS 通过但最多7结算、-17.53U/PF0.12；scan87 仅 CULTURE 通过但0结算；scan88 覆盖最后4个地址，仅 TECH 通过但0结算。旧快照的低相关类别已全部完成筛选，无部署者。manifest SHA 分别 `db2b3f76...`、`049278b3...`、`498f70ea...`、`0c639172...`、`c7a172f3...`。
- 刷新官方榜单快照（SHA `3df3f4df...`），发现159个全类别未见地址；先取10个非 CRYPTO 候选做 scan89，仅 WEATHER 通过但三档0结算，淘汰。新快照尚余149个全类别未见地址，其中59个非 CRYPTO。scan89 manifest SHA `144f0680...`。
- cryptofb 最后1U实验已结算至0持仓、0挂单、0意图、0结算故障；完成 config/DB 归档后从运行集合禁用。归档目录 `retired-cleared-20260715T073029Z`，DB SHA `5c0cbf28...`。8085 最终 enabled=0、polled=0、preview=true、walletDrifts=[]、settlementFailures=0；亏损前向组已全部清理。
- 本轮累计新增扫描688个未见候选；ACTIVE 新买账户为0，尚未找到已实现盈利方式。

## 2026-07-15 15:31–15:36 CST

- scan90 intake 10 个新非 CRYPTO 候选，2个 WEATHER 通过；一个0结算，另一个1U虽 +18.03U/PF2.21但仅1胜5负且100%依赖单笔、去最大盈利 -14.91U，其余档亏损，淘汰。manifest SHA `d39a1656...`。
- scan91 intake 10 个候选，WEATHER/CULTURE 各1个通过但三档均0结算；scan92 10/10失败；scan93 仅 MENTIONS 通过但0结算；scan94 三个通过但分别亏损、单笔依赖、0结算；scan95 覆盖最后9个非 CRYPTO 地址，9/9失败。manifest SHA `0d230ccf...`/`bfe64bfd...`/`ca60122c...`/`f118a26e...`/`93c18a66...`。
- 新快照59个非 CRYPTO 未见地址已全部筛完，无部署资格。scan96 已生成10个 OVERALL/CRYPTO 种子，但官方候选数据请求长时间无完整响应；终止重复请求，未生成 evidence、未计入已筛样本，也未使用缺失数据替代。
- 本轮累计新增扫描747个未见候选；ACTIVE 新买账户为0，尚未找到已实现盈利方式。

## 2026-07-15 15:38–15:44 CST

- 将 scan96 的10个 OVERALL/CRYPTO 候选拆为逐账户隔离 intake。9个完成且全部 fresh gate 失败；`crypto96_9` 官方响应连续超时，未生成 evidence、未计入筛选结果，保留 timeout 清单待后续重试。
- 继续逐账户处理下一组5个 CRYPTO 候选；4个完成且全部 fresh gate 失败，`crypto98_5` 官方响应超时，未计入结果。拆分后确认此前批量长等待来自个别账户，而非整体 API 故障。
- 已完成13个新的可归因候选筛选，均无回放资格；新快照 OVERALL/CRYPTO 尚余77个未完成地址（含2个超时账户）。ACTIVE 新买账户为0。
- 本轮累计新增扫描760个未见候选；尚未找到已实现盈利方式。

## 2026-07-15 15:45–15:48 CST

- 继续逐账户处理 CRYPTO 候选：完成3个，2个 fresh gate 失败；`crypto99_5` 通过。另有 `crypto99_1`、`crypto99_3` 官方响应超时，未生成 evidence、未计入结果；累计 timeout 清单4个。
- `crypto99_5` 1U/2U 回放仅6/7结算，PnL +46.59/+97.24U、PF12.70/13.18，但胜率仅33%/43%，最大盈利贡献89.98%/86.96%；5U仅7结算、PF1.20且去最大盈利转负。扩展2日回放未增加任何独立结算，严格淘汰、不部署。1d replay SHA `3f4b19ce...`，2d SHA `985b10f3...`。
- 新快照 OVERALL/CRYPTO 尚余74个未完成地址（含4个超时账户）；ACTIVE 新买账户为0。
- 本轮累计新增扫描763个未见候选；尚未找到已实现盈利方式。

## 2026-07-15 15:48–15:52 CST

- 逐账户完成9个新 CRYPTO 候选 intake，9/9 fresh gate 失败，无回放资格。
- `crypto100_4` 官方响应超时，未生成 evidence、未计入筛选；累计 timeout 清单5个。超时账户继续与正常候选隔离。
- 新快照 OVERALL/CRYPTO 尚余65个未完成地址（含5个超时账户）；ACTIVE 新买账户为0。
- 本轮累计新增扫描772个未见候选；尚未找到已实现盈利方式。

## 2026-07-15 15:52–15:55 CST

- 逐账户完成9个新 CRYPTO 候选 intake，9/9 fresh gate 失败，无回放资格。
- `crypto103_1` 官方响应超时，未生成 evidence、未计入筛选；累计 timeout 清单6个。
- 新快照 OVERALL/CRYPTO 尚余56个未完成地址（含6个超时账户）；ACTIVE 新买账户为0。
- 本轮累计新增扫描781个未见候选；尚未找到已实现盈利方式。

## 2026-07-15 15:55–15:58 CST

- 逐账户完成10个新 CRYPTO 候选 intake，8个 fresh gate 失败、2个进入回放；无新增超时。
- `crypto105_2` 各档最多8结算且均亏损/PF<1，淘汰。
- `crypto105_4` 2U 为6结算、+75.53U、PF8.58、最大盈利占44.57%、去最大盈利+37.42U，但仅3胜3负（50%）且样本不足；2日扩展未增加独立结算，保留 watchlist、禁止部署。1d replay SHA `86819dd5...`，2d SHA `f0b85363...`。
- 新快照 OVERALL/CRYPTO 尚余46个未完成地址（含6个超时账户）；ACTIVE 新买账户为0。
- 本轮累计新增扫描791个未见候选；尚未找到已实现盈利方式。

## 2026-07-15 17:01–17:11 CST

- 核对后续 authority artifacts：cryptofb1c 前向最终37 REDEEM、-29.27U，已清仓归档并物理删除，8085释放；本轮未触碰生产盘。
- SSM 复核 ACTIVE 新买=0；旧盘均 preview-only 的 QUARANTINED/SETTLE_ONLY，pending=0、walletDrifts=[]、settlementFailures=0。8083/8085未运行。
- 旧混合 cohort 有5个 reject 账户已清仓，但同一原生 cohort 仍有未结算持仓；按既有 cohort 级清理门禁不自造逐账户删除，待全 cohort 清仓。
- fresh 全类别再完成41个未见候选：41/41 intake 完整，4个进回放，0个通过完整部署门禁。summary SHA `c4f469ea...` / `fa333a5b...`。
- 最近门者 `Mbeng666` FIXED5：7结算、+5.3359U、4胜3负、PF1.4905、最大盈利占29.88%、去最大盈利+0.4912U、无停机。冻结后2/3/7日仍是同7个结算，且官方市场覆盖不完整，fail-closed，不部署。
- `gardenerCx` 仍因1/2日盈利集中仅观察；`rwo` 历史保留窗通过但后续 fresh intake 失败；无新前向模拟。
- 最新前向累计已实现 -366.62U（含已删除 cryptofb）；剩余旧盘 -337.35U。历史最佳正向前向仍是 b55 strict 2% +6.17U/8 REDEEM/PF2.17，样本不足。尚未找到可复制盈利方式。
- 下一轮 fresh 扫新增地址并隔离重试 timeout；只有 fresh intake、官方覆盖、冻结保留窗全部通过才允许新建隔离 preview。

Current run time: 2026-07-15 17:11 CST (about 10 minutes).

## 2026-07-15 18:18–18:46 CST

- 对 `gardenerCx` 做官方数据可复制性复核：最新 98 次 BUY 中 0 次在市场截止前至少30秒，中位领先 -2秒；历史回放利润无法由 10秒轮询跟单复制，三档全部退役。独立复核确认每档202 DETECT/202 SKIP/0 COPY，持仓、挂单、实时意图和结算故障均为0；ACTIVE新买账户0/6。
- CandidateIntakeEvidence 固化为schema v5：逐TRADE官方endDate覆盖100%，BUY提前>=30秒且占比>=90%，已结算仓位全分页与盈亏完全对账；缺数据、重复condition、未对账均fail-closed。全量82文件/610测试、lint和diff-check通过，独立审核APPROVE。
- 官方长周期/近期已结算盈利扫描：30个多类别active/open独立event + 20个近14天已结算高成交独立event，发现174人，排除历史地址后冻结20个活跃新候选。GATE FROZEN后20/20 fresh schema v5 intake完成、0 API/超时，0个通过，因此回放0、晋级0。主要淘汰：可复制性失败15/20，独立condition不足11，去最大赢家后不盈利11，PF不足10。artifact manifest 331文件SHA-256全部通过。
- 第二轮已启动三路并行：A扩大至近90天已结算重复盈利者并copyability-first扫描；B聚焦长结算周期/早入场可复制账户；C检索官方/成熟开源方法并设计1–3个不降门槛的单变量实验。继续禁止实盘，只有intake+跨窗口回放+独立验证全通过才能进入preview。
- 方法复核确认项目原生订单簿成本回放可直接复用，新增的有效候选源应为官方全局 `/trades` 按 proxyWallet 聚合，寻找不在排行榜的小资金、高频、可提前复制钱包。持续任务已更新为候选源、轮询频率、固定仓位三类严格单变量实验；胜率按独立condition/event与Wilson 95%下界报告，防止大规模扫描过拟合。

Current run time: 2026-07-15 18:46 CST (about 28 minutes).

## 2026-07-15 18:49–19:25 CST

- 远程读只复核：8085 preview=true，enabled/polled=0，pending=0，walletDrifts=[]，settlementFailures=0，closedMarketOpen=0；全部旧实验均为QUARANTINED/SETTLE_ONLY，ACTIVE新买仍0/6。
- 路径A官方90天重复盈利者：46个长周期active/open + 50个90天closed独立event，465个发现候选中180个新地址完成copyability-first，6个冻结，3个通过schema v5 intake；三人1天严格回放最多仅1个已结算condition且亏损，0晋级。batch manifest 622项SHA全校验。
- 路径B长周期/早入场holder：深分300个市场，27个完整未见长周期市场中选12个独立event，发现23个未见holder，3个copyability通过，schema v5 intake 0/3。最接近 `abdoohl` 源PnL +4896.11U/PF3.238，但最大盈利占50.1097%>50%，严格淘汰。A/B地址重叠0，无回放/部署。
- 新增原生官方taker-trades候选源：直接复用 `@polymarket/client.listTrades`，固定UTC窗口、原始分页、proxyWallet聚合、排除集与确定性排序。无market分区的全局流即使exact 1秒+BUY仍超官方offset 3000，已有 `unavailable_fail_closed` 证据，禁止截断使用。模块已改为hard maxTrades=3000，支持冻结/排序/互斥market condition分区，逐行校验condition归属，在请求offset3000前本地fail-closed。
- 实验可归因性加固：candidate cohort可声明 `experimentFactor=fixedUsd`；声明后1/2/5U三档除fixedUsd外，maxPosition/dailyVolume/maxOpenMarkets/lossCap/slippage/minPrice/maxPrice必须全显式且完全相同，否则拒绝生成；旧未声明cohort保持兼容。preview report新增active-experiment隔离的source→first-observation延迟p50/p90/p99，秒/毫秒幂等归一，无效/未来时间fail-closed。
- 独立代码审计APPROVE；全量83文件/644测试、lint、daemon build、diff-check通过。路径D已在冻结代码边界下启动：使用A已封存46个active/open独立condition作singleton互斥分区，统一固定5分钟窗口，必要时只允许预定1分钟/10秒子窗完整覆盖；任一片不完整则该condition不参与候选选择。

Current run time: 2026-07-15 19:25 CST (about 67 minutes).

## 2026-07-15 19:34–19:50 CST

- 路径D在冻结模块 SHA `fe421c21...` 下完成：46/46 个 long active/open condition 使用同一 UTC 5分钟 singleton 分区，11行官方 taker trade，发现7个新地址；copyability 5/7通过、2个淘汰，fresh schema-v5 intake 0/5通过，全部因最近已结算盈利失败，无回放/部署。根 manifest 后续重建为102项并逐项复算 SHA/bytes 通过；preview/live/deploy写入均0。
- 路径E将同46个condition分为5个互斥组，冻结最近12个已完成整点的5分钟窗，60/60 cell完整、209行、发现106个新地址并冻结前20。copyability 12通过、7拒绝、1个因官方 activity 缺 `outcomeIndex` fail-closed；schema-v5 intake 12/12完成、0通过，无回放/部署。
- 路径E最接近者 `pathe_14`：已结算50仓位 +55.77U、胜率56%，但PF1.053且去最大盈利 -152.34U；`pathe_07` 胜率88%但净亏 -80.97U/PF0.67，证明高胜率不等于可持续盈利，均严格淘汰。E manifest 176项逐项复算SHA/bytes通过，preview/live/deploy写入均0。
- 独立审计对D的分区、schema-v5拒绝和无运行状态写入均通过，最初唯一问题是根manifest过早生成；已修复并发起复核。下一路径F改扫距结束1小时至7天的高成交active/open市场，避免long-market样本稀疏和对称做市机器人主导。

Current run time: 2026-07-15 19:50 CST (about 92 minutes).

## 2026-07-15 19:52–20:20 CST

- 路径F改用官方 active/open/acceptingOrders 且距结束1小时至7天的高成交市场，官方首100行按event去重得到42个condition；分5个互斥组×12个整点末5分钟窗，60/60 cell完整、3509行，发现1592个全新taker地址。冻结前20后copyability 6通过、12拒绝、2个官方activity缺`outcomeIndex` fail-closed；schema-v5 intake 3/6通过。
- 路径F第一批3个回放0晋级。`pathf_19` FIXED5 1日仅6结算、+4.52U、5胜1负、PF1.91、最大盈利占29.91%、去最大盈利+1.68U，但2/3/7日均未增加样本且3日转亏，时间外复现失败，仅观察、不部署。
- 继续冻结同一已封存发现集的rank21-40作为batch2，与batch1地址0重叠。copyability 9/20通过。初次intake控制器因内部cohortId长度25超过schema上限24，在任何候选请求前统一失败；保存错误证据后以短cohortId重新运行，9/9完整、5个通过schema-v5、5个回放完整、0正式晋级。
- batch2最强 `pathf2_04`（0x7b285...cff4f）FIXED2：1日9个独立已结算condition、+33.15U、6胜3负、PF11.60、最大盈利占45.37%、去最大盈利+16.69U、无kill；2/3/7日复验均保持9结算，+31.90U、PF11.19、最大盈利占47.00%、去最大盈利+15.44U，仍差第10个独立结算，列重点watchlist且禁止部署/preview新买。
- F最终manifest 302项已逐项复算SHA/bytes通过；remote/preview/live/deployment写入均0。独立审计已发起。下一轮继续处理已封存1592地址中的后续固定批次，并在`pathf2_04`产生新的官方独立结算后重新fresh intake+严格回放，禁止把重复结算当新样本。
- 路径F最终独立审计APPROVE：42市场、60/60 cells、1592候选、batch1 rank1-20与batch2 rank21-40零重叠均独立重建一致；batch2旧cohortId错误确认在任何候选fetch前schema parse失败，corrected结果有效替代；所有replay逐condition盈亏复算一致，未发现preview/deploy/live写入。

Current run time: 2026-07-15 20:20 CST (about 122 minutes).

## 2026-07-15 20:26–20:50 CST

- 路径F继续处理同一冻结发现集 rank41–100，三个批次均与此前地址零重叠；全程只写本地证据，preview/deploy/live写入均0，ACTIVE新买保持0/6。
- batch3 rank41–60：prefilter 12/20通过（7拒绝、1个官方`outcomeIndex`缺失fail-closed），schema-v5 intake 4/12通过，4个回放、0晋级。表面盈利arm均依赖最大赢家，去最大后转亏；唯一达到11个结算的`pathf3_13` FIXED1亏损-4.25U、PF0.806，严格淘汰。独立审计APPROVE。
- batch4 rank61–80：prefilter 12/20通过，schema-v5 intake 3/12通过，3个回放、0晋级。最接近`pathf4_03` FIXED2仅4结算、+6.90U，但最大盈利占71.80%、去最大盈利-1.00U，严格淘汰。独立审计APPROVE。
- batch5 rank81–100：prefilter 9/20通过，schema-v5 intake 2/9通过，2个回放均亏损、0晋级；`pathf5_16`三档全亏，`pathf5_18`最多8结算且-54.96U。
- 至此前100名固定候选全部处理完毕。当前最强仍是`pathf2_04` FIXED2，但只有9个独立结算；保持watchlist，等新的官方独立结算后再fresh intake+严格回放，不重复计算旧9个。尚未找到可复制盈利方式。

Current run time: 2026-07-15 20:50 CST (about 152 minutes).

## 2026-07-15 20:51–21:02 CST

- 路径F batch6固定处理rank101–120，与前100地址零重叠：prefilter 5/20通过（14拒绝、1 fail-closed），schema-v5 intake 2/5通过，2个回放完成。
- 新最强候选`pathf6_03`（0x7a469ebb8442e594f20f3b0577a8a54f796f9889）FIXED5：11个独立已结算condition、+17.9707U、10胜1负（90.91%）、PF4.5962、最大赢家占16.73%、去最大赢家后+14.1273U、无kill；首次通过发现阶段全部硬门槛。
- 独立审计APPROVE：逐condition PnL、胜负、PF、集中度与边界全部复算一致；确认仅本地artifact写入，无preview/deploy/live。
- 2/3/7日扩窗均保持同一结果，但三窗的source/copy计数、11个conditionId和逐项PnL完全相同，样本指纹一致；只能算参数/窗口一致性，不能算3个独立holdout，也不能把样本量写成33。
- `pathf6_03`升级为当前最强watchlist，但尚缺真正新的时间段/市场结算、前向source→observed延迟、当时原生可执行订单簿成本与压力验证；继续禁止preview新买、deploy和live。下一步优先复用项目成熟只读观察能力收集新鲜holdout，若不存在则等待官方新独立结算后重新fresh intake+严格回放。
- 是否已找到可复制盈利方式：否；已找到一个达到90%点胜率且发现阶段盈利门槛全通过的强候选，尚未充分验证持续性。
- 路径F根manifest已在batch6扩窗完成后重建：716项，声明remote/preview/live/deployment写入均0。

Current run time: 2026-07-15 21:02 CST (about 164 minutes).

## 2026-07-15 21:03–21:13 CST

- 路径F继续同一冻结发现集：batch7 rank121–140 与前120零重叠，prefilter 5/20、schema-v5 intake 3/5、3个回放全部亏损且最多6结算，0晋级；独立artifact审计APPROVE。控制脚本未随批次留档是审计限制，后续已修复。
- batch8 rank141–160 与前140零重叠，prefilter 3/20通过、16拒绝、1个官方请求fail-closed；schema-v5 intake 0/3通过，因此回放0、晋级0。独立审计APPROVE，临时控制脚本稳定SHA `8456a2f6...58bb`，无preview/deploy/live。
- 已将通用批处理控制器固化为Path F artifact内的v2版本，并加入控制器自身SHA冻结与结束复核；后续批次将保留可审计控制器边界。
- batch9 rank161–180已由现有持续流程启动，避免重复发起。
- `pathf6_03`仍是当前最强watchlist；发现阶段11结算、+17.97U、90.91%胜率、PF4.60不变，但尚无新鲜holdout，ACTIVE新买仍0/6，禁止实盘。

Current run time: 2026-07-15 21:13 CST (about 175 minutes).

## 2026-07-15 21:13–21:24 CST

- batch9 rank161–180：prefilter 4/20、schema-v5 intake 1/4、1人3档回放；各档均亏损、PF<0.60且触发kill，0晋级。独立审计APPROVE，临时控制器SHA稳定。
- batch10 rank181–200：prefilter 3/20、schema-v5 intake 1/3、1人回放。`pathf10_04` FIXED5主窗4结算全胜、+14.15U、最大赢家占47.06%、去最大+7.49U，但样本4<10；2/3/7日均仍是完全相同4个condition，+13.75U，非独立holdout，submitted0。独立审计APPROVE，只列低优先级watchlist。
- batch11 rank201–220使用已固化v2控制器：controller SHA `d5dcba0c...1326`在开始/结束边界内自校验；prefilter 4/20、schema-v5 intake 0/4，因此回放0、晋级0。
- 零额度观察器只读可行性已确认：原生`executable_guarded`会先记官方盘口/延迟，再因global daily=0在executor前SKIP；但现有成熟部署门禁只接受3-arm正额度builder，无法安全部署单观察账户。直接绕过脚本会丢失intake/provenance/config门禁，禁止采用。
- 远端仅2 vCPU且当前高负载、swap约1.2GiB、I/O wait 47–61%，8081/8082/8084/8085多栈异常；在容量和observer-mode成熟门禁解决前，不新增常驻观察服务。ACTIVE新买保持0/6，生产盘未动。
- 路径F根manifest重建为1042项，声明remote/preview/live/deployment写入均0。当前最强仍是`pathf6_03`，尚未找到充分验证的可复制盈利方式。

Current run time: 2026-07-15 21:24 CST (about 186 minutes).

## 2026-07-15 21:24–21:55 CST

- 路径F batch12 rank221–240：prefilter 6/20、intake 2/6、2人回放、0晋级。`pathf12_19` FIXED5仅3个独立结算，+18.5191U，但最大赢家占94.44%且去最大后 -3.6851U，淘汰。独立审计APPROVE。
- batch13 rank241–260初始有5个官方`ECONNRESET`和1个真实fail-closed；只对5个传输失败原样重试。最终20=4通过+15拒绝+1真实fail-closed，intake 1/4，唯一回放FIXED5 -4.9973U，0晋级。独立审计APPROVE。
- batch14 rank261–280：prefilter 12/20、intake 4/12、12个arm、0晋级。最近门`pathf14_10` FIXED5为11结算、+2.6590U、PF1.133<1.2，去最大后 -7.8915U，淘汰。独立审计APPROVE。
- batch15 rank281–300：prefilter 4/20、intake 0/4，无回放、0晋级；独立审计APPROVE。batch16 rank301–320：prefilter 8/20、intake 3/8、3人回放、0晋级；`pathf16_17` FIXED5仅6结算、+10.7391U且最大赢家占50.807%>50%，`pathf16_01` FIXED5去最大后转亏，`pathf16_19`盈利集中/亏损，全部淘汰；独立审计APPROVE。batch17 rank321–340：prefilter 4/20、intake 0/4，无回放、0晋级；独立审计APPROVE。
- fresh watchlist只读刷新：`pathf6_03` 24h交易18<20，当前活跃度门槛失败；历史11结算、+17.9707U、90.91%、PF4.5962证据不变，但只能留历史watchlist。`pathf10_04`可复制性保持通过，仍无4个以外的新结算，不重复回放。
- 已按成熟原生清理门禁删除清仓且不合格的8085 `polymirror-forward1-v1`：3账户删除前后持仓/挂单/意图均0，外部归档及SHA校验完整。8081/8082/8084尚有持仓，不强删。8080未修改/未重启；容器健康检查受高负载影响仍为degraded，但循环HTTP200、pending=0、walletDrifts=[]、settlementFailures=0，需后续只读跟踪。
- 路径F冻结候选rank1–340已处理，全程仅本地artifact，preview/deploy/live写入均0，ACTIVE新买0/6。尚未找到经充分验证的可复制盈利方式；下一批固定rank341–360。
- 路径F根manifest在batch17后重建为1534项，声明remote/preview/live/deployment写入均0。

Current run time: 2026-07-15 21:55 CST (about 217 minutes).

## 2026-07-15 21:58–22:13 CST

- batch18 rank341–360：prefilter 7/20、intake 2/7、2人回放、0晋级。`pathf18_06` FIXED5仅5结算、+1.9567U、PF1.1306、最大盈利占86.34%且去最大 -12.6647U；`pathf18_19`三档均亏，全部淘汰。独立审计APPROVE。
- batch19 rank361–380：prefilter 5/20、intake 4/5、4人回放；新候选`pathf19_20` / 0xccbbc5ecf11071d41acbc4f0db5e5d3ec1e93bed FIXED5在发现窗11结算、+7.9456U、9胜2负（81.82%）、PF2.5353、最大盈利占30.46%、去最大 +3.9490U、无kill，通过发现硬门槛。独立审计APPROVE。
- 复用batch6成熟扩窗脚本（仅替换batch/id）跑`pathf19_20` 2/3/7日；三窗指标全通过，但均与1日完全相同的11个conditionId与逐项PnL，只能算嵌套窗一致，不是独立holdout，禁止preview新买。
- batch20 rank381–400：prefilter 20=6通过+13拒绝+1真实fail-closed（`pathf20_08`官方activity缺`slug`，不重试/不补猜），intake 2/6、2人回放均亏/样本不足，0晋级；独立审计APPROVE。
- 对batch1–17全部strict replay做只读near-miss排序：真正值得等新结算的是`pathf2_04`（仅差1个结算）、`pathf16_17`（差4个且集中度仅超0.807pct）、`pathf2_19`（差5个且集中度超9.825pct）；未降低任何门槛。
- watchlist refresh v2在成熟v1基础上只新墙4个候选，只读刷新6人：`pathf6_03`仍因18笔交易失败；`pathf10_04`、`pathf19_20`、`pathf2_04`、`pathf16_17`、`pathf2_19` 5人通过当前可复制性门槛。该刷新只证明copyability，不证明新盈利/holdout；边界SHA实算一致，零preview/deploy/live，独立审计APPROVE。
- 路径F冻结候选rank1–400已处理；尚未找到经充分前向验证的可复制盈利方式，ACTIVE新买0/6。下一批固定rank401–420。
- 路径F根manifest在batch20/扩窗/watchlist v2后重建为1796项，声明remote/preview/live/deployment写入均0。

Current run time: 2026-07-15 22:13 CST (about 235 minutes).

## 2026-07-15 22:20–22:32 CST

- batch21 rank401–420：prefilter 4/20、intake 1/4，唯一`pathf21_18`三档均仅1结算且分别 -0.9975/-1.9949/-4.9978U，0晋级；独立审计APPROVE。
- batch22 rank421–440：prefilter 3/20、intake 2/3、2人回放。`pathf22_11` FIXED5仅5结算、+20.8994U、PF5.0094、集中42.90%、去最大+9.6968U，样本不足只列低优先watchlist。
- 新强候选`pathf22_16` / 0x05d3e8e5b270710ec7c6d1ad4c702eb84536c06a FIXED5：1日13结算、+11.0959U、9胜4负（69.23%）、PF1.5551、最大盈利占18.09%、去最大+5.4731U、无kill；通过发现硬门槛。其fresh schema-v5来源对账55个盈利position、+594.97U、PF3.84、胜率81.82%、去最大+547.88U，24h交易36、BUY24、可复制100%。
- 复用成熟batch6脚本扩窗：`pathf22_16` 2/3/7日均为12结算、+27.1455U、9胜3负（75%）、PF2.8105、集中22.23%、去最大+17.7788U、无kill。1d与2d交集9、1d-only4、2d-only3；确有3个较早的新样本，比完全重复强，但2/3/7又完全相同且窗口嵌套，仍非独立holdout，禁止preview新买。独立审计APPROVE。
- 只读复核观察池后撤回对`pathf2_04`/`pathf6_03`的立即刷新建议：所谓新resolved condition均已包含在最新full intake。`pathf2_04`最新intake因PF1.0803和去最大 -21.7215U失败；`pathf6_03`因trades24h=18失败。两者均WAIT，禁止重复请求旧证据。
- watchlist refresh v3仅在v2上新墙`pathf22_16`/`pathf22_11`两行，逻辑不变；独立审计APPROVE，下轮应使用v3。
- 路径F rank1–440已处理，ACTIVE新买0/6，尚未找到经充分独立前向验证的可复制盈利方式。下一批固定rank441–460。Path F根manifest重建为1936项，声明remote/preview/live/deployment写入均0。

Current run time: 2026-07-15 22:32 CST (about 254 minutes).

## 2026-07-15 22:34–22:48 CST

- batch23 rank441–460：prefilter 5/20、intake 1/5，唯一`pathf23_04`回放0晋级。FIXED2虽26结算、+3.2711U，但PF1.0863<1.2且去最大 -10.3270U；FIXED1集中100%且去最大转亏，FIXED5亏损并kill。独立审计APPROVE。
- 只读检索确认项目尚无成熟通用入口可同时实现“任意单候选+明确since/until+互斥窗+冻结本地数据+零网络严格回放”。`strict-fixed-replay.mts`有fees/2.5%/FIXED1/2/5/完整风控但仅尾随嵌套窗；`gardener-frozen-disjoint-stress`有互斥窗但候选/窗口写死且仍联网。本轮未擅自改造或降级替代。
- batch24 rank461–480：prefilter 7/20、intake 1/7，近门`pathf24_02` / 0x0ba92e72e3c105440f54aee2751d5980960aa8d8 FIXED5为9结算、+26.9350U、8胜1负（88.89%）、PF6.3876、最大盈利占23.59%、去最大+19.4029U、无kill，仅差第10个样本。fresh schema-v5通过，24h交易83、copyability100%，对账56个盈利position、+1447.66U、PF6.51、胜率89.29%。
- `pathf24_02` 2日扩窗只8结算、+26.8482U、7胜1负、PF6.3702、去最大+19.3160U，仍样本不足。3/7日原请求均明确`ECONNRESET`；按batch13既有原则只对这两个传输失败做一次隔离重试并保留原证据，但两者仍`ECONNRESET`。最终submitted0，不继续重试，列高优先watchlist；独立审计APPROVE。
- watchlist v3在尚未运行/无summary依赖时追加`pathf24_02` baseline83；最新逻辑相对v2只新墙`pathf22_16`/`pathf22_11`/`pathf24_02`三行，其余逐字不变，独立审计APPROVE。
- 路径F rank1–480已处理，ACTIVE新买0/6，尚未找到经充分独立前向验证的可复制盈利方式。下一批固定rank481–500。Path F根manifest重建为2100项，声明remote/preview/live/deployment写入均0。

Current run time: 2026-07-15 22:48 CST (about 270 minutes).

## 2026-07-15 22:53–23:02 CST

- watchlist refresh v3首次运行并独立审计APPROVE：9人中8人当前copyability通过、1人拒绝；`pathf22_16` 24h交易23且可复制BUY占100%，`pathf24_02` 85笔且100%，继续保留；`pathf6_03`仍仅18笔，淘汰出活跃候选池，仅保留历史档案。该刷新只证明当前可跟，不证明盈利或holdout；submitted0，preview/deploy/live均0。
- batch25 rank481–500：地址唯一且与前480零重叠，prefilter 5/20、intake 3/5、3人回放、0晋级。`pathf25_06` FIXED5虽6结算、+2.7425U、PF1.2745，但去最大赢家后 -0.9394U；`pathf25_19` FIXED2虽13结算、+6.0275U、PF1.2326，但去最大后 -8.7550U，FIXED5亏损并kill；20/20淘汰。独立审计APPROVE。
- batch26 rank501–520：地址唯一且与前500零重叠，prefilter 6/20、intake 2/6、2人回放、0晋级。`pathf26_07`官方activity缺`outcomeIndex`，证据级fail-closed；`pathf26_15` FIXED2仅6结算、+5.3921U且最大赢家占100%，去最大后 -11.9689U；`pathf26_19` FIXED5虽12结算但 -0.7280U、PF0.9663。20/20淘汰。独立审计APPROVE。
- 四名重点候选只读复算一致：研究池排序为`pathf22_16`、`pathf24_02`、`pathf19_20`；`pathf6_03`移出活跃池。四者现有回放都已含官方手续费与2.5%不利价格，但仍假设限价可全额成交，缺历史盘口深度、真实跟单延迟和真正非重叠前向样本，因此“已验证持续盈利”仍为0，ACTIVE新买保持0/6。
- 路径F rank1–520已处理。下一批固定rank521–540（batch27，zero-based start520）；继续使用v2控制器和共享API锁，不改策略逻辑。

Current run time: 2026-07-15 23:02 CST (about 284 minutes).

## 2026-07-15 23:03–23:25 CST

- batch27 rank521–540首轮运行后因重复指令复用了同一目录，summary/frozen被覆盖，而旧intake-progress/replay仍残留，独立审计REJECT。旧`batch27`不得作为正式结果证据，也不得删除其失败链。
- 使用未修改的成熟v2控制器在全新`batch127`目录运行`127 520`作为batch27纠正件：20地址与原batch27有序完全一致、与前520零重叠，summary明确rankRange 521–540。结果prefilter 4/20、intake 2/4、2人回放、0晋级；两人各arm均亏损/集中/样本不足，20/20淘汰。独立逐arm/SHA审计APPROVE。根目录`batch27-supersession.json`明确旧batch27作废、batch127为权威替代，不代表rank2521。
- batch28 rank541–560：prefilter 3/20、intake 2/3、2人回放、0晋级，独立审计APPROVE。新观察`pathf28_11` FIXED5为7结算、+9.2123U、6胜1负（85.71%）、PF2.8435、最大赢家占28.13%、去最大后+5.2151U、无kill；质量良好但样本7<10，至少等3个全新独立结算后再fresh验证，禁止preview。
- batch29 rank561–580：prefilter 4/20、intake 0/4、无回放，20/20淘汰。`pathf29_01`虽源PnL+35.6483U且去最大仍正，但PF1.1434<1.2；`pathf29_17`胜率31.25%、PF1.0923、去最大-220.2898U。独立审计APPROVE。
- batch30 rank581–600：prefilter 6/20、intake 0/6、无回放，20/20淘汰。`pathf30_01`仅4样本、+462.0439U，但最大赢家占57.83%且去最大-57.9571U；其余5人上游fetch失败并在schema-v5内apiNoErrors=false安全拒绝。独立审计APPROVE。
- 研究池按市场类别只读拆分：最清楚的正证据是`pathf24_02`的CS整场/地图胜负（合计6样本、6胜、+21.2868U，跨4个event）；其次`pathf19_20`网球整场（7样本、6胜1负、+7.9349U，去最大仍+3.9382U）；`pathf22_16`网球整场仅4样本且主窗单event贡献88.7%，降为低一级。网球盘内、Dota等均因样本/最大赢家依赖不计正策略类别。三者仍无真正前向holdout。
- 运行态只读审计：8081/8082/8084均preview=true、ACTIVE=0，全部账户QUARANTINED或SETTLE_ONLY；当前轮copied/pending/挂单/live intent/walletDrifts/settlementFailures均0。旧仓最近报告合计57仓、约814.45U，只安全结算不强删。8080健康检查连续超时转unhealthy，其他预览实例degraded；按安全边界未修改、未重启。
- 路径F rank1–600已处理，其中rank521–540只认batch127纠正件。ACTIVE新买0/6，尚未找到经充分验证的可复制盈利方式；下一批固定rank601–620（batch31，zero-based start600）。

Current run time: 2026-07-15 23:25 CST (about 307 minutes).

## 2026-07-15 23:27–2026-07-16 00:08 CST

- batch31 rank601–620：prefilter 3/20、intake 0/3、无回放，20/20淘汰；三名intake盈利口径均亏，独立审计APPROVE。
- watchlist v4只在v3末尾追加`pathf28_11`并独立审计APPROVE后运行：10人中9通过、`pathf6_03`仅19笔再次拒绝；`pathf22_16`25笔、`pathf24_02`87笔、`pathf28_11`26笔，均copyability100%。该刷新只证明当前可跟，不证明盈利/holdout，preview/deploy/live均0。
- `pathf24_02`因活动83→87且可能补第10样本，按规则只做一次fresh schema-v5 intake与1日严格回放。intake仍全门通过；新回放FIXED5为9结算、+24.3620U、7胜2负、PF3.4366、最大赢家占21.92%、去最大+16.8298U。相对旧主窗公共6、旧独有3、新独有3，总样本仍9，不能累计成12；继续禁止晋级/preview。run-summary完整披露本地schema断言导致三次相同参数调用，最终证据链/SHA/逐condition独立审计APPROVE。
- batch32 rank621–640：prefilter 2/20、intake 0/2、无回放。`pathf32_20`源盈利+25,468.07U、PF1.916、去最大仍正，但median票面56.05U>50、p90 1060U>500，无法按普通小额复制，严格淘汰；独立审计APPROVE。
- batch33 rank641–660：prefilter 3/20、intake 1/3、1人回放、0晋级。`pathf33_07` FIXED5仅8结算、+2.1518U、PF1.1335<1.2、去最大-6.7366U；淘汰。独立审计APPROVE。
- batch34 rank661–680：原始有5个ECONNRESET；按batch13成熟模式只对这5人原样重试一次并保留原证据。最终prefilter 4/20、intake 0/4、无回放；`pathf34_09`因median票面83.91U失败，重试新过的`pathf34_14`因unreconciledResolvedPositions=1失败。summary-final独立审计APPROVE，20/20淘汰。
- batch35 rank681–700：prefilter 4/20、intake 2/4、2人回放、0晋级。`pathf35_05`与`pathf35_16`源账户利润/PF很高，但小额严格回放分别亏损；`pathf35_15`官方activity缺slug属确定性schema错误，fail-closed且不重试。独立审计APPROVE，20/20淘汰。
- batch36 rank701–720：主批prefilter 5/20、intake 1/5、`pathf36_09`回放。FIXED1主窗15结算、+14.2656U、PF2.1042、最大赢家占42.27%、去最大+2.7744U，机械硬门通过；但仅3胜12负=20%，去top2后-6.5462U，厚尾风险高。唯一transport timeout `pathf36_04`按成熟模式只重试一次仍同一timeout，fail-closed，summary-final审计APPROVE。
- `pathf36_09`扩窗2/3/7日FIXED1均为同一16结算、+18.7832U、4胜12负=25%、PF2.4539、去最大+7.2920U；1日15个全部包含其中，扩窗只新增1个条件，不能算独立验证。7日FIXED2为19结算、+47.1500U、6胜13负、PF2.4780、去最大+21.0260U，但去top3转负，94.74%样本为网球且Lincoln/Croatia Open两簇贡献约92.75%净利。独立审计APPROVE；定位为“低胜率网球非对称收益被动观察”，明确排除稳定盈利/晋级/ACTIVE池，仅等未来非重叠前向样本。
- batch37 rank721–740：prefilter 1/20、intake 0/1、无回放。`pathf37_10`源盈利样本51、48胜3负=94.12%、+669.73U、PF1.832，但median票面697.98U、p90 1118.82U，远超50/500U可复制门槛，严格淘汰；`pathf37_14`缺slug确定性失败，不重试。独立审计APPROVE。
- watchlist v5仅在v4追加`pathf36_09`（baseline trades24h=315），11个ID/地址唯一，逻辑不变，独立审计APPROVE；v5尚未运行，下轮统一使用v5。路径F rank1–740已处理，所有新增工件均local-only，ACTIVE新买仍0/6。尚未找到经充分独立前向验证的可复制稳定盈利方式；下一批固定rank741–760（batch38，zero-based start740）。

Current run time: 2026-07-16 00:08 CST (about 350 minutes).

## 2026-07-16 00:09–00:30 CST

- batch38 rank741–760：prefilter 3/20、intake 1/3、1人回放、0晋级；`pathf38_17`源账户历史盈利，但FIXED1/2/5小额回放均亏，严格淘汰。独立审计APPROVE。
- batch39 rank761–780：prefilter 3/20、intake 2/3、2人回放、0晋级；`pathf39_11`严格回放无已结算样本，`pathf39_14` FIXED5虽4胜0负/+8.3029U但仅4样本且最大赢家占68.55%，均淘汰。独立审计APPROVE。
- watchlist v5首次运行并独立审计APPROVE：11人中10个当前copyability通过、`pathf6_03`因24h交易15拒绝；`pathf22_16`32、`pathf24_02`96、`pathf28_11`31、`pathf36_09`305且可复制BUY占95.74%。刷新仅证明活跃/可复制，不证明盈利。
- `pathf24_02`按新活动只做一次fresh intake与严格1日回放：fresh schema-v5通过；源账户60个已结算position、+1306.2229U、PF4.1019、50胜10负、去最大仍+1199.802U。FIXED5为11结算、+27.4485U、9胜2负（81.82%）、PF3.7453、最大赢家占20.11%、去最大+19.9164U；但所谓新增2个条件已存在于15:34证据，只是滚动窗口选择变化，不是真正未来holdout。11个condition仅7个独立event，CS2占6/11且贡献77.4%净利，前两event贡献约71.6%；只够进入隔离前向preview候选，不足以声称稳定盈利或90%目标达到。独立审计APPROVE。
- 已冻结pathf24前向preview验收卡：T0后只算全新唯一event正式REDEEM，同一event的地图/盘口合并；至少30个未来event。PASS需净PnL≥+10U、PF≥1.5、胜率≥80%且Wilson下界≥60%、最大回撤≤20U、去top1/2/3仍盈利、去top3 PF≥1.2、滑点median≤1%/P95≤2%/单笔≤2.5%、账本100%对平。若要声称90%需至少27/30且Wilson下界≥70%；第4个亏损event即90%目标提前失败，第7个亏损event即基础胜率失败。
- pathf24隔离preview部署前置双审计均NO-GO。机器侧：8080及8081/8082/8084均unhealthy，2 vCPU为0% idle、I/O wait约42–49%、约3668个僵尸进程、内存仅约2GB available、swap约1GB、现有旧仓约814.44U；8085虽空闲且磁盘余46.5GB，当前容量仍不足以安全新增3个arm。代码门禁侧：工作区dirty；现有fresh cohort未冻结FIXED1/2/5完整arms；schema要求fixedUsd实验显式min/max price而部署门禁又禁止price filter，合法配置必然冲突；且缺不触碰生产compose的原生build-only入口。禁止绕过或降级部署，ACTIVE新买保持0/6。
- batch40 rank781–800：prefilter 4/20，4人fresh intake全部拒绝，回放0、晋级0；`pathf40_03`因P90票面1179.61U不可小额复制，`pathf40_07`净亏-50.89U/PF0.677，`pathf40_10`综合盈利胜率47.13%，`pathf40_19`有1个resolved position无法对账fail-closed。独立审计APPROVE，local-only、preview/deploy/live均0。
- 路径F rank1–800已处理。当前最强研究候选仍是`pathf24_02`，但尚未找到经充分独立前向验证的可复制稳定盈利方式；部署门禁与远端容量恢复前只继续低成本发现/回放。下一批固定rank801–820（batch41，zero-based start800）。
- 路径F根manifest已在batch38–40、watchlist v5与pathf24 fresh recheck完成后重建：3324项，包含三批与最新证据，remote/preview/live/deployment写入均0。

Current run time: 2026-07-16 00:30 CST (about 372 minutes).

## 2026-07-16 00:31–00:36 CST

- batch41 rank801–820：prefilter 5/20、intake 0/5、无回放、0晋级，外部写入0。五人中`pathf41_04`盈利口径-112.07U/PF0.459，`pathf41_07`合并派生已结算后去最大盈利-1.2375U，`pathf41_12`median票面55.37U>50，`pathf41_16`median票面195.69U>50，`pathf41_17`盈利口径-337.29U/PF0.707；全部严格淘汰。两次独立交叉审计均APPROVE，且确认与前800地址零重叠。
- 路径F rank1–820已处理；下一批固定rank821–840（batch42，zero-based start820）。pathf24部署仍为机器容量和代码门禁双重NO-GO，ACTIVE新买0/6。
- 根manifest在batch41后重建为3394项，batch41共70项，remote/preview/live/deployment写入均0。

Current run time: 2026-07-16 00:36 CST (about 378 minutes).

## 2026-07-16 00:42–00:55 CST

- batch42 rank821–840：20个冻结地址与前820零重叠；prefilter 3通过、16拒绝、`pathf42_09`因官方activity缺`slug`确定性fail-closed且不重试；3个schema-v5 intake中2通过、1拒绝，2人严格回放，1个本地晋级。完整工件链与43条condition PnL独立审计APPROVE，preview/deploy/live/remote写入均0。
- `pathf42_02`源intake通过但FIXED1/2/5小额回放均亏，FIXED5仅1胜5负、-21.6358U且kill，严格淘汰。
- 新观察`pathf42_04` / `0x5bc9a1d1ca6ed6d5d6a831a184b58a8e2078b2ee`：fresh诚实盈利口径58个position、+51.3096U、49胜9负=84.48%、PF4.9679、去最大+43.8810U；24h交易79、copyability100%，median票面2.018U/P90 2.061U，适合小额。
- `pathf42_04`主窗FIXED5：14个condition对应14个唯一event，+5.9309U、10胜4负=71.43%、PF1.2969、最大赢家16.80%、去最大+1.5789U、最大回撤10.6240U；去top2后-1.9608U/PF0.902、去top3后-5.2378U/PF0.738。天气8 event净-3.0071U，网球6 event净+8.9380U；利润余量薄，主窗只够观察。
- 复用batch36成熟扩窗控制器，仅替换batch/candidate，并在共享官方API锁内顺序跑2/3/7日。2d与3d完全相同：FIXED5为12个唯一event、+19.0055U、10胜2负、PF2.9018、最大回撤6.3048U；去top1/2/3后分别+13.3305/+7.9106/+4.1985U，去top3 PF1.420。天气10/12且+21.6223U，网球2/12净-2.6168U。1d与2d仅1 condition交集，但因同结束点、嵌套窗和共同风控限额造成路径选择变化，不能视为独立holdout；3d不增加证据，禁止累加。7d因官方activity缺`eventSlug`确定性fail-closed，不重试。
- 扩窗控制器模板一致性、共享锁、冻结SHA、2/3日逐condition与7日fail-closed均获独立审计APPROVE；批准仅指证据链完整，不代表稳定盈利。
- `pathf42_04`类别符号在1d与2d间反转，说明窗口/路径敏感；定位为高优先级观察但暂低于`pathf24_02`，冻结FIXED5等待真正T0后唯一event前向验证，不得事后删除天气或调参。
- watchlist v6相对v5仅追加`pathf42_04`正确地址与baselineTrades24h=79；12个ID/地址唯一，逻辑及零外部写入边界不变，独立审计APPROVE，尚未运行。
- 路径F rank1–840已处理；自动任务已切至下一批rank841–860（batch43，zero-based start840），避免整点重复覆盖batch42。pathf24/pathf42均未部署，ACTIVE新买0/6。
- 根manifest在batch42扩窗与watchlist v6后重建为3465项，batch42共70项，remote/preview/live/deployment写入均0。

Current run time: 2026-07-16 00:55 CST (about 397 minutes).

## 2026-07-16 00:56–00:59 CST

- batch43 rank841–860在共享官方API锁内运行：prefilter 2/20、intake 1/2、1人回放、0晋级；preview/deploy/live/remote写入均0。
- `pathf43_04`源intake通过：50个盈利口径position、+651.3960U、41胜9负=82%、PF4.1920、去最大+445.9359U，24h交易111、copyability100%、median票面4.32U；但严格小额回放FIXED1无成交，FIXED2仅1结算/-0.1120U，FIXED5仅3结算且0胜3负/-11.0455U/PF0，严格淘汰。
- `pathf43_17`源表面仍盈利，但合并derived后有1个resolved position无法对账，`profitabilityReconciled=false`，schema-v5 fail-closed，无回放。
- 路径F rank1–860已处理；自动任务已在整点前切到下一批rank861–880（batch44，zero-based start860），避免重复覆盖batch43。batch43独立审计进行中。
- 根manifest在batch43后重建为3522项，batch43共57项，remote/preview/live/deployment写入均0。

Current run time: 2026-07-16 00:59 CST (about 401 minutes).

## 2026-07-16 01:00–01:09 CST

- batch43独立审计APPROVE：ranks841–860与前840零重叠，20→2→1回放→0晋级，23个attempt与全部SHA/逐condition一致，零外部写入。`pathf43_04`进一步拆解确认是历史跨品类盈利但当前1d全LoL的高频双边调仓型；FIXED5只复制8/69 BUY和5/42 SELL，dedup/40U日限额/固定额SELL份额不足丢失大量开平仓与盈利腿，准确淘汰标签为“FIXED5不可复制型”，不是源账户无能力。
- batch44 rank861–880：prefilter 3/20、intake 0/3、无回放、0晋级。`pathf44_05`盈利口径-21464.71U/PF0.277；`pathf44_15`-588.12U/PF0.252且最大赢家占71.42%；`pathf44_17`虽+78.27U但PF1.0968且去最大-107.02U，全部淘汰。独立审计APPROVE，零外部写入。
- batch45 rank881–900：prefilter 9/20、intake 5/9、5人回放；condition级仅`pathf45_06` FIXED5机械达门，11 conditions、+10.0144U、6胜5负、PF1.4011、最大单condition占22.85%、去最大单condition+2.0219U。工件链与15个arm逐condition独立审计APPROVE，零外部写入。
- 对`pathf45_06`执行必需的event级后门：11 conditions按eventSlug合并后仅9个独立LoL event、5胜4负=55.56%、+10.0144U、PF1.5014、最大回撤9.9837U。ZNT–Senshi同一event两条件合计+13.7640U，占gross wins45.90%；去top1即-3.7496U/PF0.812，去top2/3分别-10.4544/-15.0330U。9/9全LoL，Road of Legends两event贡献+15.7068U，其他联赛合计亏损。event样本<10且去最大event转亏，纠正condition级假通过，取消扩窗并最终淘汰；不得用2/3日扩窗挽救。专门工件`batch45/pathf45_06-event-level-post-gate.json`保留映射与门禁。
- `pathf45_06` event级后门获独立审计APPROVE：11 condition到9 event映射无缺失/冲突，全部指标、门禁、最终淘汰与零外部写入逐项复算一致。
- 同口径稳健性暂排：`pathf42_04` 2d组合12 event、+19.0055U/PF2.902、去top3+4.1985U；`pathf24_02` 7 event、+27.4485U/PF6.490、去top3约+0.265U；`pathf45_06`去top1即亏，已淘汰。path42跨event稳健性暂优，path24绝对收益/PF更优；两者仍无真正未来holdout。
- 路径F rank1–900已处理。batch44/45均由主线程预留并完成，自动任务下一批固定rank901–920（batch46，zero-based start900），禁止重复旧批次。ACTIVE新买仍0/6，未部署、未实盘。
- 根manifest在batch43–45与event级后门后重建为3685项（batch43/44/45分别57/62/101项），remote/preview/live/deployment写入均0。

Current run time: 2026-07-16 01:09 CST (about 411 minutes).

## 2026-07-16 01:14–01:18 CST

- batch46 rank901–920在共享官方API锁内运行：prefilter 1通过、18拒绝、1个fail-closed；唯一`pathf46_18` schema-v5 intake拒绝，无回放、0晋级，外部写入0。独立审计APPROVE，确认与前900零重叠及全链SHA一致。
- `pathf46_08`官方activity缺必需`outcomeIndex`，属确定性schema不完整而非传输故障；不重试、不补猜、无证据文件并fail-closed正确。
- `pathf46_18`虽然24h交易99且copyability98.98%，但合并42个derived后诚实盈利口径92 positions、-53.9322U、PF0.8001、去最大-66.3550U，并有1个resolved position无法对账；严格fail-closed淘汰。
- 路径F rank1–920已处理；下一批固定rank921–940（batch47，zero-based start920）。
- 根manifest在batch46后重建为3734项，batch46共49项，remote/preview/live/deployment写入均0。

Current run time: 2026-07-16 01:18 CST (about 420 minutes).

## 2026-07-16 01:19–01:38 CST

- 新增并双重独立审计通过统一事件级门禁`pathf-event-level-post-gate-v2.mts`，SHA `b0b228210887073c02a7356b608ea8514ed92c17f336954fb72bf135fddd8719`。它在condition级机械门之后按`eventSlug`合并，强制任一来源冲突fail-closed、`(strategy,sizeValue)`联合匹配、候选身份/计数复核、event与condition PnL守恒、输入SHA冻结及`wx`不可覆盖；仅写本地artifact，无网络/preview/deploy/live。
- 对全部历史condition级提交批次统一重算：batch6/22/36/42事件级通过；batch19因11 condition仅8 event淘汰；batch45因11 condition仅9 event且去最大event后-3.7496U淘汰。`pathf24_02`不在原summary机械提交集合内，沿用其已审计手工事件结论：仅7个event，仍不足进入前向验证。
- batch47 rank921–940：20→6 intake→2批准回放→0 condition/event晋级，独立审计APPROVE。近门`pathf47_03`源诚实口径50 position、44胜5负、+8.0008U、PF1.7812、median票面1.016U；FIXED5为8 condition、+8.2489U、PF153.17、去最大+4.8073U，但合并后仅7个event。2/3/7日快照重复同一8 condition/7 event，不能当三次独立或严格可复现验证；保留5U watch-only，至少等待3个真正新增且非重叠event，1/2U无成交不保留。ACTIVE/部署均0。
- batch48 rank941–960：20→6 intake→1批准回放→0晋级。唯一`pathf48_01` FIXED5仅2个结算、+3.3974U，且最大赢家占51.36%；样本和集中度均失败，淘汰。独立审计APPROVE。
- batch49 rank961–980：20→6 prefilter通过、12拒绝、2个本次捕获的确定性`activity.slug`缺失fail-closed；6 intake中3批准并回放，3人FIXED各档均未晋级。`pathf49_02`源历史很强但FIXED2 -2.0903U、FIXED5 -34.9770U并kill；`pathf49_14` FIXED5 -6.2620U；`pathf49_17` FIXED5 10结算但-7.1668U并kill，全部淘汰。event级0；全链SHA、9个arm、80个0600文件和零外部写入获独立审计APPROVE。
- 路径F rank1–980已处理；下一批固定batch50 rank981–1000、zero-based start980。每个新batch必须先跑v2 condition控制器，再跑event-level-v2；只有`eventLevelSubmittedCandidates`可作为扩窗候选。任何嵌套尾随窗不得冒充独立holdout。
- 根manifest重建为3994项，含9份`event-level-summary-v2.json`及batch47–49；remote/preview/live/deployment写入均0。尚未找到经充分未来样本验证的可复制稳定盈利方式，90%目标未达到。

Current run time: 2026-07-16 01:38 CST (about 440 minutes).

## 2026-07-16 01:43–01:55 CST

- batch50 rank981–1000：20→3 intake→1批准回放→0 condition/event提交，独立审计APPROVE。`pathf50_18` FIXED5按event仍仅5个、4胜1负、+1.1173U、PF1.2237，但最大盈利占62.88%、去最大后-2.7260U，且只复制8/20 BUY；当前FIXED配置淘汰、不占watch-only。`pathf50_11`虽源账户极强但median票面99.6U/P90 1121.45U，普通小额不可复制，淘汰。
- batch51 rank1001–1020：20→5 intake→1批准回放→0提交，事件级审计APPROVE。唯一回放`pathf51_04` FIXED1/2/5分别为-1.9834U、+1.2892U、-4.1175U；2U只有3 event且单一赢家占100%、去最大转亏，全部淘汰。`pathf51_01`仅因56个收益样本中1个resolved position未对账而fail-closed；其余口径+125.8321U/PF4.6452/去最大+119.0173U、median票面3.10U。只列“官方数据补齐后的单次fresh intake重试”，不是交易观察或部署候选；unreconciled归零前禁止回放。
- batch52 rank1021–1040：20→3 intake→1批准回放→0提交，独立审计APPROVE。`pathf52_06`源口径89.09%胜率/PF5.453，但FIXED5仅6 condition、-16.4782U、PF0.3402、最大赢家57.57%、去最大-21.3701U并kill，严格淘汰。三批全部local-only，ACTIVE新买0。
- 观察池统一复核：没有任何artifact能证明T0后真正未来、非重叠验证；所有2/3/7日盈利扩窗均为旧数据嵌套窗，禁止相加。历史观察优先级为`pathf6_03`、`pathf42_04`、`pathf24_02`、`pathf47_03`、`pathf22_16`、`pathf36_09`；其中path6历史事件分散度最好，但活跃度曾不足；path36低胜率厚尾且不符合90%目标。下一份有效证据必须是统一T0后的唯一event前向preview。
- 远端只读复核（SSM command `50b7f77e-a185-401b-8b32-a4e026fe8a69`、controls `22eeb58a-1d2f-40a3-8eac-3c4a5afe2648`）：2 vCPU瞬时idle 0%、I/O wait 41%、load约3.1、zombie 3670、available memory约1.9GiB、swap使用1.0GiB；8080/8084超时，8081/8082 degraded，8085未监听。现存preview全部QUARANTINED/SETTLE_ONLY，ACTIVE新买0/6；49个旧open positions、pending/live intents/unresolved settlement failures均0。机器容量继续NO-GO，不新增preview。
- forward preview代码门禁只读复核NO-GO：当前dirty改动中声明式fixedUsd虽要求三臂完整，却只要求数值互异，未锁死1/2/5；schema强制每臂min/max price，而shadow部署明确拒绝price filter；现有正确provenance构建脚本会继续启动默认compose，隔离shadow脚本只接受预建精确SHA镜像，仍缺build-only→isolated shadow闭环。相关39 tests与tsc虽通过但未覆盖跨层冲突。因这些文件与其他并行工作重叠，本线程未覆盖修改。
- 路径F rank1–1040已处理；下一批固定batch53 rank1041–1060、zero-based start1040。根manifest重建为4193项，含12份event-level-summary-v2；remote/preview/live/deployment写入均0。尚未找到经充分未来验证的可复制稳定盈利方式。

Current run time: 2026-07-16 01:55 CST (about 457 minutes).

## 2026-07-16 01:56–02:01 CST

- batch53 rank1041–1060：20→4 intake→3批准回放→0 condition/event提交；72个0600文件、全链SHA、9个arm与零外部写入获独立审计APPROVE。
- 唯一新增watch-only为`pathf53_10` / `0x88de2de73965dcb571472befd278329a61d20950`，只保留FIXED5：7 condition恰好对应7个独立event、6胜1负、+11.3822U、PF3.2771、最大event盈利占44.15%、去最大仍+4.1504U、无kill；14 BUY复制8（57.1%），9 SELL复制7（77.8%）。当前0提交正确，只能等待至少3个T0后真正新增且非重叠event，再重新全量事件门；不得用嵌套2/3/7日窗凑数，也不得称接近部署。
- `pathf53_03` FIXED5虽7 event/6胜1负/+5.6984U，但最大赢家51.91%超门、去最大仅+0.1471U，85 BUY只复制9，当前FIXED配置淘汰。`pathf53_14` FIXED2虽14 condition合并13 event且+4.8909U/PF1.2043，但去最大-7.8920U；FIXED5合并10 event后仍亏-15.7591U并kill，全档淘汰。`pathf53_16`有3个resolved position未对账，fail-closed且不回放。
- 路径F rank1–1060已处理；下一批固定batch54 rank1061–1080、zero-based start1060。根manifest重建为4265项，含13份event-level-summary-v2，remote/preview/live/deployment均0。目标仍未达成。

Current run time: 2026-07-16 02:01 CST (about 463 minutes).

## 2026-07-16 02:02–02:06 CST

- 自动任务接管并完成batch54 rank1061–1080：20人冻结且与前1060地址零重叠，prefilter 8/20通过、fresh schema-v5 intake 2/8通过、2人严格FIXED1/2/5U回放、condition/event级均0晋级。全流程仅写本地artifact，ACTIVE新买0/6，preview/deploy/live/remote写入均0。
- `pathf54_05`各档均亏：FIXED1为2结算/0胜2负/-1.9894U/PF0，FIXED2为3结算/0胜3负/-7.9819U/PF0，FIXED5为6结算/2胜4负/-23.5835U/PF0.1643、去最大赢家后-27.2466U；严格淘汰。
- `pathf54_16` FIXED1/2无可复制结算；FIXED5仅4结算/2胜2负/-13.0163U/PF0.1314、去最大赢家后-14.2827U，并触发5%日亏kill；严格淘汰。表面盈利但intake被拒的`pathf54_10`因median票面56.83U>50，`pathf54_18`因P90票面684.62U>500，均不适合普通小额复制，不进入观察池。
- batch54独立只读审计APPROVE：rank边界、20→8→2→0计数、6个intake拒绝原因、两名候选逐臂复算、event-v2、全部SHA和引用均一致；预期90个文件完整且全0600，无凭据泄漏、误删或外部写入。
- 观察池无新增，优先级保持`pathf6_03`、`pathf42_04`、`pathf24_02`、`pathf47_03`、`pathf22_16`、`pathf36_09`；`pathf53_10`继续watch-only等待至少3个T0后真正新增event。路径F rank1–1080已处理，下一批固定batch55 rank1081–1100、zero-based start1080。
- 根manifest已重建并校验：4355项，batch54共90项，含14份event-level-summary-v2；remote/preview/live/deployment均0。部署继续机器与代码双重NO-GO；目标仍未达成。

Current run time: 2026-07-16 02:06 CST (about 468 minutes).

## 2026-07-16 02:10–02:14 CST

- 主线程在自动任务结束后继续完成batch55 rank1081–1100：20人冻结且与前1080地址零重叠，prefilter 2/20通过，fresh schema-v5 intake 0/2通过，0回放、condition/event级0提交。全链只写本地artifact，preview/deploy/live/remote写入均0。
- `pathf55_08`表面closed口径50仓49胜1负、+16.7901U/PF48.97，但补入5个已结算derived position后的诚实盈利口径为55仓49胜6负=89.09%、仅+0.0878U、PF1.0052，去最大赢家后-2.2072U；没有可承受滑点或误差的利润边际，严格淘汰，不进入回放或观察。
- `pathf55_16`表面盈利口径51仓、+18402.66U/PF2.423、去最大仍正，但median票面67.48U、P90 830.02U超出普通小额可复制门槛，且1个resolved position未对账；fail-closed淘汰，不因源账户大额盈利放宽门槛。
- batch55独立只读审计APPROVE：rank边界、20→2→0计数、两名拒绝理由、event-v2空记录、全部SHA/引用和零外部写入均一致；预期56个文件完整、无空文件/符号链接/误删且全0600。
- 观察池无新增、排序不变。路径F rank1–1100已处理；下一批固定batch56 rank1101–1120、zero-based start1100。根manifest重建为4411项，含15份event-level-summary-v2，remote/preview/live/deployment均0；目标仍未达成。

Current run time: 2026-07-16 02:14 CST (about 476 minutes).

## 2026-07-16 02:15–02:43 CST

- 主线程连续完成batch56–64、固定rank1101–1280，全部使用共享官方API锁、原生schema-v5 intake、FIXED1/2/5U strict replay与event-level-v2；各批漏斗：b56 20→5 intake→2回放→condition/event各1，b57 20→2 intake→1回放→0，b58 20→6 intake→0，b59 20→5 intake→2回放→0，b60 20→1 intake→0，b61 20→4 intake→1回放→0，b62 20→1 intake→0，b63 20→4 intake→0，b64 20→3 intake→0。全部local-only，ACTIVE新买0/6，preview/deploy/live/remote写入均0。
- 新强观察`pathf56_14` / `0x9755458cc4f51228de267039b8c6feb967e8ab85`只保留FIXED5：12 condition恰为12个唯一event、11胜1负=91.67%、+18.0903U、PF2.8097、最大event赢占18.26%、去top1/2/3仍+12.9619/+8.6099/+4.6143U，去top3 PF1.4616、无kill，condition/event双门与独立审计APPROVE。当前活跃观察排第1；综合历史稳健性仍可把`pathf6_03`列第1、`pathf56_14`第2。
- `pathf56_14`尚不能称稳定盈利：Wilson95%下界仅64.61%；12个event全部同日结算，10/12为网球且网球+22.9580U、非网球合计-4.8678U；FIXED5只复制16/54 BUY=29.63%，另有3个开放token/成本14.9849U。首轮至少等待10个T0=`2026-07-15T18:17:57Z`后新入场、非重叠、跨至少3个结算日的唯一event，并要求至少9胜、整体及去top1/2/3仍正、PF>=1.2、无kill、旧开放暴露闭合；这仍只够继续观察。若按既定正式门槛，最终至少需要18个新event并达到总计>=27/30。
- 观察池已清理为6人：当前活跃排序`pathf56_14`、`pathf6_03`、`pathf42_04`、`pathf24_02`、`pathf47_03`、`pathf53_10`。新增`watchlist-refresh-controller-v7.mts`严格复用v6逻辑，仅替换候选数组与最新baseline；独立审计初次因path24 baseline 96非最新而REJECT，修正为97后APPROVE，最终SHA `52b48e6d1cf3e2c267850d022806402e28596a45f1a8738e9eee1ca38efd1045`。v7尚未运行；只在真正新活动可能增加独立event时使用。
- b57/58/60/61/63/64均无保留价值并严格淘汰；b59仅`pathf59_10`保留低优先条件复核资格：当前FIXED5仅4个同日LoL event、4胜0负、condition PnL+3.0517U，但3个开放token成本12.9855U，至少等待6个T0后新event且旧暴露闭合后才允许一次fresh复核，不进正式watch。b57_02、b62_10均因官方activity缺slug确定性fail-closed，只允许上游恢复后原参数单次重试。
- `pathf62_18`仅列“官方数据补齐后单次fresh intake重试”：唯一失败为unreconciledResolvedPositions=1；其余52仓+21.2601U、PF1.4950、去top+17.1586U、median/P90票据3.02/3.07U、copyability100%均过门。未对账归零前禁止回放；补齐通过也只能进入strict replay，不能直接进观察池。
- b56、b57、b58、b59、b60、b61、b62、b63、b64及watchlist v7均获独立只读审计APPROVE；全部边界、计数、拒绝/回放、event映射、SHA、文件完整性和零外部写入声明一致。路径F rank1–1280已处理；下一批固定batch65 rank1281–1300、zero-based start1280。
- 根manifest最终重建为4991项，含24份event-level-summary-v2与watchlist v7，remote/preview/live/deployment均0。部署继续机器与代码双重NO-GO；尚未找到经真正未来样本充分验证的可复制稳定盈利方式。

Current run time: 2026-07-16 02:43 CST (about 505 minutes).

## 2026-07-16 02:44–02:55 CST

- 完成batch65 rank1281–1300。原始批次遇到10个相同的TLS `ECONNRESET`传输失败，完整保留原始错误与原summary；严格复用成熟batch34重试控制器，仅对这10个ID在共享官方API锁内各重试一次，全部成功。纠正后权威漏斗为20→5 prefilter→1 intake批准→1 strict replay→0 condition/event提交，全程local-only，ACTIVE新买0/6，preview/deploy/live/remote写入均0。
- 因原batch65的不可变event门已读取旧summary，采用既有纠正镜像模式：`batch65/summary-final.json`与`batch165/summary.json`字节完全一致，SHA均为`1d53bb2ba34269e3f4fd27584de47b95bf2af2483abac892967ea07c02ce098c`；纠正说明SHA `b06d877164d0e1cb3252612627da8e77bcc5ae82f007f2742cd412622ebb731d`；batch165 event-v2 SHA `f52c32f7b362524680585e9e4107feae52e8b30f0f3d072928a9290ef8120d57`。原summary仍仅作传输故障留痕，不再作为最终计数依据。
- `pathf65_09`严格淘汰：FIXED1/2/5仅5/7/7个结算event；去最大赢家后分别为-3.990U/-3.449U/-20.342U，FIXED2最大赢家占59.62%，FIXED5 PF仅1.150，三档均不满足样本、分散度和稳健盈利门槛。
- `pathf65_10`不进入观察或回放，只保留官方数据补齐后的单次fresh intake重试资格：除1个未对账resolved position外，诚实口径54仓、+152.02U、PF1.523、去最大+105.82U、median/P90票据12.40/31.71U、copyability100%均过门。补数后仍未对账则直接淘汰；若归零也只能重新通过intake后进入strict replay。
- 独立复核确认纠正链APPROVE并允许推进batch66。观察池无新增，路径F rank1–1300已处理；下一批固定batch66 rank1301–1320、zero-based start1300。
- 根manifest重建为5078项，含batch65、batch165纠正镜像与25份event-level-summary-v2；manifest SHA `7aac847e955b60e3d38b4262c12bf8d12304bd26ff0118776b00e4cc8169eaec`，remote/preview/live/deployment均0。目标仍未达成。

Current run time: 2026-07-16 02:55 CST (about 517 minutes).

## 2026-07-16 03:02–03:18 CST

- batch66 rank1301–1320首次启动误用了不合适的本地锁包装，在恰好完成`pathf66_01–07`初筛后被停止；冻结件、progress与14份attempt/response原样保留，7人均为有效拒绝。`pathf66_08–20`当时无任何文件，无intake/replay/summary，相关进程为0。
- 严格复用batch2断点恢复与batch65纠正镜像模式；恢复脚本SHA `013aec957e8ebbf1d67389ffc0f8c28f76f30012429d4efe8411a5f187b5d404`经运行前独立审计APPROVE，只对08–20各请求一次，前7逐SHA锁定不改写。恢复在外层`/tmp/polymirror-17-21.lockf`与共享官方API `lockf`内完成。
- batch66最终权威漏斗为20→3 prefilter→1 intake批准→1 strict replay→0 condition/event提交。`pathf66_09` FIXED1/2/5分别为2/11/3个结算event、0胜2负/3胜8负/0胜3负、-1.9889/-3.1004/-24.9766U、PF0/0.8058/0；5U触发kill，三档全部淘汰。`pathf66_13`仅median票面99.42U超标，`pathf66_20`仅P90票面578.65U超标；两者数据完整、无未对账，不给补数重试或watch名额。
- 权威件为`batch66/summary-final.json`与字节相同的`batch166/summary.json`，SHA均`c9aad00bb522caae4eb0e4c69bdd4baff91fc81c56b557c09b298cf69b0d3062`；correction-note SHA `600d1a26df5e05229f06eb371d7355a954c950ca8ac3e4fca0e8252e3f6ff193`；batch166 event-v2 SHA `d3d4631871ce51b254b96061b16f8fa808a74af6fcccbb437812e533d920eab5`，0 condition/0 event提交。
- 最终独立审计APPROVE：151项检查确认原前7 SHA未变、08–20各一次、20→3→1→1→0、intake/replay复算、镜像/事件门和零外部写入全部一致。观察池无新增，watchlist v7不刷新。
- 根manifest重建为5146项，26份event-level-summary-v2，SHA `dd7c4de57aec268d221f7869dbe6ad0360961d063f09b410f620592b62a42500`，remote/preview/live/deployment均0。路径F rank1–1320已处理；下一批固定batch67 rank1321–1340、zero-based start1320。目标仍未达成。

Current run time: 2026-07-16 03:18 CST (about 540 minutes).

## 2026-07-16 03:19–03:28 CST

- batch67 rank1321–1340在成熟双锁内完成：20→10 prefilter→2 intake批准→2 strict replay→0 condition/event提交；event-v2与最终90项独立终检均APPROVE，全部local-only，ACTIVE0/6。
- `pathf67_01` FIXED1/2/5分别4/4/6个event、0胜4负/0胜4负/5胜1负、-9.3714/-14.9259/+8.1862U、PF0/0/2.3974。5U去top1仍+3.4481U但去top2为负，Wilson下界43.65%，5/6为LoL且全部同日；不进正式观察池、不单独刷新，只允许未来自然新增event后重新发现。`pathf67_04`三档均亏，FIXED5为6 event/3胜3负/-13.2939U/PF0.1126，淘汰。
- 唯一prefilter fail-closed为`pathf67_15`：官方activity缺必需`slug`，属确定性SDK schema错误而非传输故障；不做transport retry、不补造字段。仅上游恢复或坏行自然滚出窗口后允许原参数单次重试。
- 其余intake拒绝均为经济或小额不可复制失败；无“只差补数”的单次重试对象。观察池无新增，watchlist v7不刷新。
- 关键SHA：summary `210591c9e95f3ae24a28e2ca4fd3ca846c2a78d7af48652f8ddd1ff43e5521ff`；event-v2 `ba4ff829ea3387f03bc821333a39a1cc8922784d7b64bc031b11b1a038c8c621`。根manifest重建为5245项、27份event-v2，SHA `b8ab88d8727edf728d72607692e06d76aa40919b676a6c512dcbb747ece0cf83`，remote/preview/live/deployment均0。
- 路径F rank1–1340已处理；下一批固定batch68 rank1341–1360、zero-based start1340。目标仍未达成。

Current run time: 2026-07-16 03:28 CST (about 550 minutes).

## 2026-07-16 03:29–03:32 CST

- batch68 rank1341–1360：20→5 prefilter→2 intake批准→2 strict replay→0 condition/event提交；event-v2与独立94项终检APPROVE，local-only、ACTIVE0/6。
- `pathf68_15`回放亏损：FIXED2为1 event/0胜1负/-5.9803U；FIXED5为6 event/3胜3负/-5.3122U/PF0.7487、去最大-14.8087U，淘汰。`pathf68_18`只有FIXED5产生2 event/2胜0负/+0.1442U，但最大赢家占80.15%、Wilson下界约34%，另有约15U开放暴露；不进watch、不单独刷新。
- `pathf68_19`只保留官方数据补齐后的单次fresh intake：除4个resolved position未对账外，+20.56U、91.43%胜率、PF4.05、去最大仍+16.16U、票据约1.1U均过门。仍未对账则淘汰；归零也只能进入strict replay。`pathf68_02/06`经济性已失败，不因未对账或源盈利重试。
- `pathf68_05/13`均因官方activity缺`slug`确定性fail-closed，不做transport retry；只允许上游恢复后原参数单次重试。
- 关键SHA：summary `358cd7e99256a67eda06c7044d07921bdc38be43e717c2ddc0c8c54ce632b3e2`；event-v2 `e07ea4ef11c6cf78d87bca78c4d15098b5d91c420277c3a1dea8bbb9921d5f74`。根manifest5318项、28份event-v2，SHA `92ed6da4ef69f73e344bfb5cfd314bc16af2f20c0a2ddc4c9943384feaa158fa`，外部写入0。
- 路径F rank1–1360已处理；下一批batch69 rank1361–1380、start1360。目标仍未达成。

Current run time: 2026-07-16 03:32 CST (about 554 minutes).

## 2026-07-16 03:33–03:36 CST

- batch69 rank1361–1380：20→7 prefilter→0 intake批准→0回放/提交；event-v2与94项独立审计APPROVE，所有20个prefilter及7个intake均单次成功请求、无错误，local-only、ACTIVE0/6。
- `pathf69_17`是唯一数据补齐单次fresh intake候选：仅`unreconciledResolvedPositions=1`失败；其余诚实口径52仓、+105.5090U、89.58%胜率、PF9.0645、最大盈利占6.70%、去最大仍+97.5590U、median/P90票据3.45/7.89U均过门。仍未对账则淘汰；归零后也只能进入strict replay。
- 其余6人经济性本身失败：亏损、PF过低、去最大转亏或依赖单一大赢家；即使有未对账也不重试。观察池无新增。
- summary SHA `369f7a3bf7622a5e7ac70749b2e2d7b4f9f26445202e463402e3c765591ea310`；event-v2 SHA `465c45e44413ea8764266d78e5c472016fd690b5133c46eca5b6cd4a6c599736`。根manifest5399项、29份event-v2，SHA `b56239123eece2724317a4b02272773c46fcf8e6174d50f37a423f6c1a5fc34f`，外部写入0。
- 路径F rank1–1380已处理；下一批batch70 rank1381–1400、start1380。目标仍未达成。

Current run time: 2026-07-16 03:36 CST (about 558 minutes).

## 2026-07-16 03:37–03:40 CST

- batch70 rank1381–1400：20→3 prefilter→0 intake批准→0回放/提交；event-v2与独立审计APPROVE，local-only、ACTIVE0/6。
- `pathf70_01`源盈利强（+1491.63U/PF5.91/去最大+877.97U），但median/P90票据84.74/1182.87U远超小额复制门槛；当前范围淘汰。`pathf70_15/16`真实口径分别-123.33U/-172.46U，淘汰。无补数或watch对象。
- `pathf70_07`因官方activity缺`outcomeIndex`确定性fail-closed，非传输错误；只允许上游恢复后原参数单次重试。
- summary SHA `70f155c7b0591f9639b49a79e1ec8571eb77d40b339c9487a43df3f552c2bbf6`；event-v2 SHA `660cba735bc9577da9451bfecea96f8ad8f7a0c7bae61a61e95c7fd23c35db55`。根manifest5459项/30份event-v2，SHA `f068fdb2a2f6e274924d3c0a7e4bb0b1469ba9e9019edbec989c25dc885ce5fc`，外部写入0。
- rank1–1400已处理；下一批batch71 rank1401–1420、start1400。目标未达成。

Current run time: 2026-07-16 03:40 CST (about 562 minutes).

## 2026-07-16 03:41–03:43 CST

- batch71 rank1401–1420：20→2 prefilter→0 intake批准→0回放/提交；event-v2与79项独立审计APPROVE，local-only、ACTIVE0/6。
- `pathf71_03`仅`unreconciledResolvedPositions=1`失败，其余+250.57U、胜率54.72%、PF1.897、去最大+166.85U、最大盈利占15.8%、median/P90票据6.43/21.57U、copyable BUY95%均过门；只允许补数后一次fresh intake，归零后也只能进strict replay。`pathf71_07`盈利强但median票据69.35U超小额门槛，当前范围淘汰。
- `pathf71_06`官方activity缺slug确定性fail-closed，不做transport retry。
- summary SHA `66665ef350e61022ab09b852223d0010fa04de050fd3c28f3d77ce9f4e4be277`；event-v2 `da505a7c9aa07c4c298f0300c29b6b89f08ca04a7e406d6d016ff1ca3aa97ada`。manifest5514项/31 event-v2，SHA `a4f813b6e5bbb8cd34b960ef49674b74295e6cfcc8f34e5b42c7963d2878a7ed`，外部写入0。
- rank1–1420已处理；下一批batch72 rank1421–1440/start1420。目标未达成。

Current run time: 2026-07-16 03:43 CST (about 565 minutes).

## 2026-07-16 03:44–03:56 CST

- batch72 rank1421–1440：20→6 prefilter→2 intake批准→2 strict replay→0 condition/event提交；原event-v2 0提交与112项独立算术/SHA审计APPROVE，local-only、ACTIVE0/6。
- `pathf72_16` FIXED5名义为9 event/6胜3负/+11.7440U/PF1.7834，去top1/2/3为+5.1870/-0.5956/-5.7240U、全部同日、复制13/52、4个开放token/成本19.9735U；不新增第7个观察、不替换现有6人，仅池外候补。`pathf72_13`利润薄且依赖大赢，淘汰。`pathf72_14`仅因4个resolved未对账失败，允许补数后单次fresh intake；其他拒绝者经济性或票据失败。
- 发现并独立确认严格回放结算门缺陷：`strict-fixed-replay.mts`会把“唯一最高当前价格”当winner，并在`closedTime`缺失时回退`endDate`，导致仍`closed=false/acceptingOrders=true`的市场被误记为settled。72_16 Messi 1+ goals被错误记-4.9931U；72_13另有Vici Gaming未闭盘被错误记+4.388U。72_16保守最多8个官方confirmed event；72_13剔除假结算后约-3.984U，淘汰更确定。
- 后续正式样本必须同时证明official `closed=true`、`acceptingOrders=false`、`closedTime`非空、terminal唯一0/1 winner；fresh fetched snapshot未落盘的一律fail-closed。现有event-v2只能视为condition/event聚合门，不再单独证明官方结算；历史6人观察池启动专项复核，完成前暂停新增批次与任何ACTIVE。
- summary SHA `f161cf4de9663cfdeccf8d9ce9aa7fd64ee20a52670934ec306a2a482509fbce`；event-v2 `a167fc54a9247b46ac7440e6c8e688a177ce252a51c10aa6b7a5f39878210cae`。manifest5594项/32 event-v2，SHA `e5ef5d3b0e9e82bc4a57b1ec801d68ba23042b0f199f5cda4bd7939d10450f8c`，外部写入0。
- rank1–1440已处理；下个未扫批次为batch73 rank1441–1460/start1440，但必须先完成官方结算专项复核与新门禁。目标未达成。

Current run time: 2026-07-16 03:56 CST (about 578 minutes).

## 2026-07-16 04:19–05:13 CST

- 按本轮显式权威切换到v5：replay `d8a3a2ccfd4e02f249268670fb0f8a4cd9abefccd1c665c8eb63c3fae06afd11`、batch controller `1d7d20cb4709ca31988e56fa6e8c0f7953c3662c82f79236c32af59fa021aa8b`、event gate `cce06c91ccafe590632c6e98b1cecc9875e4df5ed0e7da5a4d93afa03bb27c61`。batch73–79覆盖rank1441–1580，全部schema-v5 intake、persisted official-terminal-v5 replay与event-v5，独立终审APPROVE；各批漏斗分别20→1→1→1→0、20→1→1→1→0、20→4→1→1→0、20→4→1→1→0、20→7→3→3→0、20→4→2→2→0、20→9→3→3→0。
- batch73–79无event级晋级。最佳新near-miss仅`pathf77_17` FIXED5：7 condition/event、6胜1负、+5.3437U、PF2.0704、去最大仍+1.6549U，但样本<10，不进正式观察池；`pathf73_16`、`74_05`、`75_17`、`76_07`、`77_06/10`、`78_05/11`、`79_02/13/18`均因亏损、kill、样本或集中度淘汰。`pathf75_09`、`pathf79_05/16`仅保留官方resolved对账归零后的单次fresh intake资格，不主动重复刷新。
- 冻结发现集总计1592人。终端batch80 rank1581–1592原运行在完成01–06后中断；成熟恢复链原件不覆盖，01–06 SHA保持，`pathf80_07`因无法证明请求未开始而歧义fail-closed且不重试，仅08–12在双锁内各请求一次。权威漏斗12→2→1→1→0；`pathf80_05` FIXED1/2/5为2/8/9 event、-1.9814/-10.7142/-19.9493U、PF0/.2329/.1821，2U/5U kill，淘汰。
- batch80权威为`summary-final.json`与字节相同`batch180/summary.json`，SHA `ab7682b7cc8e8dfe6421580beea472c7a6a36550c0cf7f2d9fdd721ff935899b`；恢复控制器冻结SHA `33db5062cc210cd57fa5bd198af3b918b5d3db1aae82e213cfa25fa9019c5eea`；canonical event-v5 SHA `89b92966e74e7819b93ca0efef74ab952e85764b18172bea6a6f9f75d4bdc0e7`，0提交。独立终审APPROVE。
- SSM只读健康审计CommandId `25f23b3b-2f3f-4806-b056-9cbc52a806e1`：8080超时，8081/8082/8084为preview-only degraded且pending/drift/settlement failure均0；主机I/O wait 50%、3670 zombies、可用内存约2.25GB，部署继续NO-GO。8080未修改/重启/停止；ACTIVE新买0/6；未刷新watchlist。
- 至此Path-F冻结rank1–1592已全部处理，下一未扫rank为无；必须等真正新官方快照才能继续新rank，不能把1593当现成批次。正式观察排序仍`pathf56_14`、`pathf6_03`、`pathf42_04`、`pathf24_02`、`pathf47_03`、`pathf53_10`，全部缺T0后充分未来样本。
- 独立审计artifact SHA `5ab7a2eceabebc8d83e49cda699465ad83d8ac384bb1a7265bb7160e55c007fa`。根manifest已重建并全量复验：6158项、0 mismatch，SHA `275d4f339dc4eba6edfcd483af9e5371977c23243f52bd55375464123f0db87b`；remote/preview/live/deployment writes均0。
- 尚未找到经充分未来验证、扣除成本后可复制且低回撤的稳定盈利方式。

Current run time: 2026-07-16 05:13 CST (about 54 minutes).

## 2026-07-16 05:14–05:19 CST

- 对batch78/79补做独立v5终审，均APPROVE。batch78漏斗20→4→2→2→0，summary/event SHA分别`cd9d9ab746721b77db81284ce22238142ec4a3952a24209f3180430eac4e4903`/`ad7686abb55e305d2401c5ab34af914fb80273c34bd256190dc30a1651f65fcf`；batch79为20→9→3→3→0，SHA `49b9fd1c9c8f0e665551cd7d757189ebb6959a2f8237e656273b2d4d146a2a94`/`7813a02d4d213c9ad2f252a5e3a1304a61d647f9dd9f403e46c18a4622c59f7e`。官方终态、cutoff、唯一0/1赢家、condition/event映射与全部证据SHA独立复算一致，无伪结算。
- batch78：`pathf78_05`三档均亏；`78_11`仅5U有+1.1440U，但只有2个event且最大赢家占55.37%；其余intake失败，全部淘汰。batch79：`79_02/13/18`三档均因亏损、kill、样本<10或集中度失败淘汰。只保留`79_05`、`79_16`在unreconciled=1归零后的单次fresh intake资格；`79_14`另有PF1.1438<1.2，不重试。
- 修正batch80双身份：定时任务执行的`batch180`只是batch80的字节镜像，不是独立批次。三路只读审计APPROVE后，本地无网络收口gate生成唯一权威`batch80/recovery/event-level-summary-v5.json`，SHA `39183fd6612146a633a25e4b69f227d7bc80c6882dcabcc3eac483a6faa7970a`；其`sourceBatch=80`，并固定`batch180.separateBatch=false/countInDiscovery=false`。终局12人漏0/重0，12→2→1→1→0；无condition/event提交。
- 正式保留池收缩为3人：`pathf56_14`、`pathf6_03`、`pathf42_04`。样本<10的`pathf24_02`、`pathf47_03`降为非正式watch-only；`pathf53_10`从正式池淘汰。ACTIVE仍0/6，禁止实盘。
- 自动任务已更新：discovery1592人全部耗尽，禁止重跑batch73–80；batch180永不重复计数。下一阶段只等T0后真正新增的唯一event做前向preview，或对明确data-only候选执行一次fresh intake。仍未找到经充分未来验证的稳定盈利方法，90%胜率未证实。
- 根manifest重建并全量复验：6159项、0 mismatch，SHA `1114016b406abcc77523c835582288b559e5a56e7ef6c81bd6c4a7c6aa6395ab`；remote/preview/live/deployment写入均0。

Current run time: 2026-07-16 05:19 CST.

## 2026-07-16 05:20–05:47 CST

- 完成唯一一次data-reconciliation fresh schema-v5 intake，固定4人：`pathf75_09`、`pathf75_16`、`pathf79_05`、`pathf79_16`。执行前控制器与事件门经三路独立只读审计最终APPROVE；controller SHA `06ff37f51e9b3944a54b1029af232b5a72775ad129400ec8795cc1bfc9f16a15`，event gate SHA `9c133b1775ab013f849d087c995d66f357e568c987d36e195dac2d99320291f1`。全上游summary/evidence/SDK/source-tree固定哈希，四人各一次、无自动重试，双lockf、local-only。
- 权威漏斗为4 fresh intake→1批准→1 official-terminal-v5 replay→0 condition资格→0 event资格/提交。Summary SHA `a711ee468d44f2694f4792d17692edf5e783f394a85635f18c9812599ecde207`；event-v5 SHA `4785240201faa2089b106e48129f87df994dc29400bcedb58287a48b64168067`；终局三路独立审计均APPROVE。
- 永久淘汰：`pathf75_09`仍unreconciled=2；`pathf75_16`仍unreconciled=1且median ticket=50.949989U>50；`pathf79_05`变为unreconciled=2且copyable BUY仅88.095%。`pathf79_16`虽fresh全门通过、unreconciled=0，但FIXED1/2/5分别0/2/6个official settled condition、PnL 0/-0.498094/-28.909914U，PF N/A/.749826/.035240，2U/5U最大赢家占100%，5U触发kill，故运营淘汰。四人的一次性重试资格全部消耗，禁止再次刷新。
- 事件门额外要求去top1/2/3盈利event后PnL仍正；本轮没有任何arm进入事件聚合。正式保留池仍仅`pathf56_14`、`pathf6_03`、`pathf42_04`，等待真正T0后非重叠未来event；ACTIVE新买0/6，禁止实盘。
- 根manifest用成熟finalizer重建并全量复验：6188项、0 mismatch，SHA `fdb1f5096962ad5344d6121a569752ce9a02a857df29ef6fff964329c626f2aa`；remote/preview/live/deployment writes均0。尚未找到经充分未来验证的稳定盈利方式或90%胜率。

Current run time: 2026-07-16 05:47 CST.

## 2026-07-16 06:03–06:04 CST

- 正式保留池前向基线已冻结：T0=`2026-07-15T21:51:13Z`，仅`pathf56_14`、`pathf6_03`、`pathf42_04`；baseline SHA `09f07a80d7588331e0c1a63bdcf5b6958beb4c20b4f0ecf5278c9c3401413734`。首个完整非重叠24h窗口到`2026-07-16T21:51:13Z`才结束。
- 在外层`/tmp/polymirror-17-21.lockf`与共享官方API lockf内运行一次append-only官方活动探针；三人均完整返回，T0后TRADE/REDEEM均0，因此未运行fresh schema-v5 intake、FIXED1/2/5 replay或event gate，未新增淘汰，正式池不变，ACTIVE新买0/6。
- 探针summary SHA `e5e0d3a5960606772b8af1159af539db76497e91aed44c9b22e279dc13fa1418`；decision SHA `9e981db3cf51db4f41c6ed1adac07dfaba026818b6f62376c0d5848c1ee7c2b5`；run manifest SHA `d8bab592d2a59fe53bcbc63de619d2aa31577754fadb47567b57c4ce8c29da09`，5/5文件哈希复验一致。仅新增本地artifact，remote/preview/deploy/live写入0。
- 尚未找到经充分未来验证、扣除成本后可复制且低回撤的稳定盈利方式；当前有效未来样本为0，盈利指标不可评估。下一次只在最小45分钟间隔后继续活动探针；没有新活动不得刷新intake或回放。

Current run time: 2026-07-16 06:04 CST.

## 2026-07-16 06:09 CST

- 按小时自动任务继续运行；完整probe之间至少45分钟，首个严格非重叠24h窗口仍在`2026-07-16T21:51:13Z`结束。报告固定仅“有效市场 / 盈利 / 简要分析”三段，≤300中文字。
- 成熟finalizer已改为同目录暂存、`fsync`后原子替换，并重新封存全部新增前向证据：根manifest共6196项、全量复验0缺失/0不一致，SHA `70649ba470d8f846bc0ceb711b1d3b52b40b6764b894eb0b8be6423a4171f8ce`；finalizer SHA `8beb8e0ccf1fbafd25c704d15b1e945686f7468398fc6df16345f2b2bb76cf5f`。ACTIVE新买0/6，禁止实盘；稳定盈利与90%胜率仍未证实。

## 2026-07-16 06:18–06:29 CST

- 在正式窗口/结算样本仍为0时预注册主策略与独立性门：只认每个候选FIXED5，FIXED1/2仅诊断；至少两个不同候选分别过30-event/PnL/PF/回撤/去top1-3/累计胜率>=90%/Wilson门，并满足>=10个24h窗口、|日PnL相关|<=0.5及双Jaccard<=0.2。policy SHA `b1a363bdc3b63433d8c54e18cd0dc9d2d790461cc47a36bd550616d3d69374f4`。
- 发现逐窗各自重置200U会确定性丢失旧仓晚结算，且终局前已SELL清仓的condition PnL可能永不入settled ledger。正式方法改为每个cutoff从T0/200U累计重放全部不可变窗口、复核前缀checkpoint、持续抓取所有旧condition、按完整condition ledger重算event；禁止逐窗相加。另冻结market快照契约：cutoff后首个计划运行且fetch start偏差<=15分钟、全累计condition、requested==returned、分页/唯一性完整，SDK legacy缺失及非终态价格一律fail-closed。formal method SHA `956d97549086fc61ced2dd63af4f58a44950f61e0900d864c3585c01dbd3c3c6`。
- 小时automation已固定两份新SHA和累计账本边界；累计控制器/event gate未独立APPROVE前，只允许继续官方活动probe，不得形成正式PnL。ACTIVE0/6，禁止实盘。

## 2026-07-16 07:32 CST

- 正式前向链已在0个正式窗口/0个未来结算样本时完成并独立APPROVE：collector `76d2d4f6e575e05a0b4798d09309fcb587609e1c61efd391cca0a6ad187b6b8b`（selftest `2e9807d7368f79e7f47eef0c3bf687861949f61598ebd0044fe5f57854c4c886`）；累计replay `70b029bb351fa254ca655a47e34d00254182ae92163ac3a289bc1288c055b814`；独立event gate `5447ce8c851d565c2bb215c3cdd31eca1f0b3a2cf3bf63007fa83b063ed495db`；cutoff总控 `09cd548e94a62d5acce19a9f213c59a83b628f02be321c0d323dd78c7efc540b`。
- 正式cutoff唯一入口为总控；它严格采三候选、从T0/200U累计重放FIXED1/2/5、只用FIXED5计成功、独立按官方eventSlug/0-1终局复算，并将三份result、gate与seal原子封存。缺页、15分钟超时、模糊终局、SHA/checkpoint不一致、缺seal或孤儿状态全部fail-closed；gate REJECT是完整结果但不是盈利。
- Automation保持ACTIVE并改到每小时`:52`；首窗于`2026-07-17 05:51:13 CST`截止，计划`05:52`在双lockf内运行总控，优先于probe。截止前主线程实测collector/controller均read-only skip，文件数不变且无锁残留。
- 根manifest在双锁内重建并独立全量复验：6203项、0缺失/0额外/0 SHA或字节不一致，SHA `90ff6a4250a1bb34b9dc10142edf3a75ab428e463746a69065089a928be23293`。当前未来正式event仍0，PnL/PF/胜率/回撤不可评估；尚未找到稳定盈利或90%胜率，ACTIVE0/6，禁止实盘。

## 2026-07-16 08:05–08:07 CST

- 小时automation在07:52未生成新任务；确认无锁、无staging、无孤儿目录后，于08:05在两层`lockf`内用冻结probe controller `0168af3bb6b3844b3d6abed5edd9cc75836f133b7b37fbd6f04765b38c87a885`补跑一次，未触碰preview、部署或实盘。
- 新probe完整：`pathf42_04`新增18笔TRADE、3笔REDEEM，覆盖18个市场；`pathf6_03`新增0笔TRADE、1笔REDEEM；`pathf56_14`无新增。summary SHA `daa4322dc8126d5f8225ca3d791dc679ae8e3e517cbb278180bbeb558e248b3d`，三份evidence SHA全部匹配。
- 这些只是T0后活动观察，尚无完整24小时正式窗口和官方终局event，不能计入盈利。正式PnL/PF/胜率/回撤仍不可评估；保留池不变，ACTIVE0/6，禁止实盘。
- 根manifest重建并全量复验：6207项、0缺失/0额外/0 SHA或字节不一致，SHA `91219d11f8625b4ac3db005063645c5c84b8a902af9cf64f3a7d8da866ef4e47`。

## 2026-07-16 08:53–09:42 CST

- 08:53第二次完整A组probe：`pathf56_14`新增2笔TRADE，`pathf42_04`新增8笔TRADE，`pathf6_03`无新增；summary SHA `5f902816b2d80a0a4d12e37ddfb9f8a216a7e1e1b30aadbfb005b34e6fffb940`。这些只是活动观察，仍无完整24h正式窗口或官方终局盈利证据。A根manifest重建并深验6211项，SHA `d2a0e22dd7890b225726bfd33017c2fd6fb626d9e3eb8abca2b6d860b86d3a22`。
- 小时任务漏跑根因是带时区的`DTSTART`被偏移8小时；已只修正为每小时第52分钟、不含`DTSTART`。调度保持ACTIVE，下一次为09:53:39 CST。
- B组发现链在官方API之前因controller→tsx→child祖先授权不兼容而fail-closed；无市场数据、无published `run-v1`，保留`run.lock`与staging失败证据，永久禁止清理/修复/重试。
- C组新发现独立终审APPROVE：37 conditions、4组、12窗口、48/48单元、1704行，重建748个新地址；discovery seal SHA `3a8e71b818c825561902eaf2734e6caf5f2cf3ccb94050affcb8c6731efeff51`。冻结exact3后，评估链经双重离线审核并唯一运行一次。
- C评估最终3人全部淘汰：`cohortc_01`预筛通过但schema-v5 intake为-$62.668164、41个resolved未对平；`cohortc_02`虽历史盈利但最大赢家贡献61.42798%>50%；`cohortc_03`因24h交易11<20、卖出/赎回2<3在预筛淘汰。intake批准0、replay0、formalAdmission=false，禁止重跑。evaluation seal/summary SHA `7b488e27b09a71c5f45dff2afb298dd6ddeb9f18476515bee93a6ac6ebab7790` / `ad3a9efe3e850e24c5e4d5b9d0a621d507f5a50daa1fe4f9e9a43a8e38001fec`，24/24文件独立终审APPROVE。
- 已预注册下一轮D组：只按C sealed discovery原始排序取rank4–23共20人，不跳选、不与exact3重叠；当前只离线构建，独立APPROVE前禁止默认入口/API。A/B/C/D证据禁止拼接；ACTIVE0/6，禁止实盘。稳定盈利与90%胜率仍未证实。

## 2026-07-16 09:53–09:55 CST

- 当前不在正式cutoff后15分钟内；最近complete probe为`2026-07-16T00:53:41Z`，间隔60分钟且无probe lock、staging或孤儿目录。已核验probe/controller/collector/cumulative replay/event gate及baseline/policy/formal-method全部SHA与冻结权威一致。
- 在两层`lockf`内只运行一次冻结`forward-probe-v5.mts`。新probe `2026-07-16T01:54:29Z`三候选全部complete，新9笔TRADE/9个市场：`pathf56_14` 6笔，`pathf42_04` 3笔，`pathf6_03` 0笔；共8个网球市场和1个武汉气温市场，新REDEEM=0。summary SHA `6d1f75f12c12e3af6e4f18e9a78b4b27f45415a384e0dcc6e2e6bbb527907785`，三份证据SHA与summary引用完全一致。
- 该probe只是活动观察。首个24h正式窗口尚未结束，且无`results-v5/seal.json`；未运行intake/replay/event gate，未形成正式PnL或新淘汰。未来正式event仍0，PnL/PF/胜率/回撤不可评估，找到=否。ACTIVE新买0/6，preview/deploy/live/remote写入0。
- 用冻结finalizer `8beb8e0c...`原子重建并全量复验根manifest：6215项，actual/listed一致，0 hash mismatch，manifest SHA `d102800f54ca154f78329092466484356bf76ef84b156264f963b3b4e67a2252`。下一步仍是满45分钟后probe；首个cutoff `2026-07-16T21:51:13Z`后15分钟内必须优先唯一总控。

Current run time: 2026-07-16 09:55 CST (about 2 minutes).

## 2026-07-17 18:40–18:42 CST

- 当前`2026-07-17T10:40Z`不在正式cutoff后15分钟内；冻结probe/controller/collector/cumulative replay/event gate及baseline/policy/formal-method SHA全部匹配，无锁、staging、temp或在途进程。首个cutoff `2026-07-16T21:51:13Z`没有`results-v5/seal.json`，不得补写正式PnL或降级采用probe。
- 距最近complete probe已超过45分钟，按双`lockf`只运行一次冻结`forward-probe-v5.mts`。新run为`forward-v5/probes/2026-07-17T10-40-53-000Z`，summary SHA `8dd19c167108af91c7fd1f4b11f7962f35618166c2404625744910d251578591`，状态`incomplete_fail_closed`：`pathf56_14`出现逻辑活动键payload冲突`0x3d0b20...::redeem`，因此全组三候选不完整，禁止intake/replay/event gate及任何收益结论，也不清理或重跑。
- 仅作不计收益的活动留痕：`pathf6_03` complete，新增22 rows=15 TRADE/7 REDEEM、13市场；`pathf42_04` complete，新增60 rows=33 TRADE/27 REDEEM、33市场。两份evidence SHA分别`8ee00129...`/`2656fb11...`；`pathf56_14`无evidence发布。汇总的48笔TRADE/46个市场不能拼成正式样本。
- `results-v5/seal.json`仍不存在；正式样本、PnL、PF、胜率、回撤均不可评估，找到=否，ACTIVE新买0/6，preview/deploy/live/remote写入0。下一正式入口只允许在`2026-07-17T21:51:13Z`后15分钟内由唯一总控按fail-closed规则处理。
- 冻结finalizer `8beb8e0c...`在双锁内原子重建根manifest；6218 listed/actual、0 missing/extra/hash mismatch，manifest SHA `4a3a20b8e5275e8413189708c7bf65353d03fa4b2dad46725073a9b419e6060d`。

Current run time: 2026-07-17 18:42 CST (about 2 minutes).

## 2026-07-29 12:49–12:50 CST

- 当前`2026-07-29T04:49Z`不在任一正式cutoff后15分钟内；正式controller/probe/collector/cumulative replay/event gate及baseline/policy/formal-method SHA全部与冻结权威一致。无在途进程、残留锁、staging、temp或无summary孤儿；`results-v5/seal.json`仍不存在，禁止补写正式PnL或采用probe替代。
- 距最近complete probe已超过45分钟，在两层`lockf`内只运行一次冻结`forward-probe-v5.mts`。新run为`forward-v5/probes/2026-07-29T04-49-37-000Z`，summary SHA `1df133002205bbd2389406e54c708987dabbbc90e896b08a5e49a2356aeb2675`，状态`incomplete_fail_closed`：三候选TRADE第一页官方请求均超时。0条可用新增TRADE/REDEEM，禁止清理、重跑、intake、replay或event gate。
- 正式前向账本、淘汰表与保留池均不变：`pathf56_14`、`pathf6_03`、`pathf42_04`；ACTIVE新买0/6。正式PnL、样本、胜率、PF、回撤仍不可评估，找到=否；preview/deploy/live/remote写入0，8080未触碰。
- 冻结finalizer `8beb8e0c...`在双锁内原子重建根manifest：6219项，manifest SHA `98ed37e5d1c04aa7401735abb4a08c01bcfdbcd21887393f151036a783e29fb0`。

Current run time: 2026-07-29 12:50 CST (about 1 minute).

## 2026-07-29 12:53–12:56 CST

- 当前`2026-07-29T04:54Z`不在任一正式cutoff后15分钟内；两份memory已完整读取。冻结probe/controller/collector/cumulative replay/event gate及baseline/policy/formal-method SHA全部匹配。上一轮`04:49:37Z` incomplete probe已完整封存，无在途进程、残留锁、staging/temp或无summary孤儿；`results-v5/seal.json`仍不存在。
- 冻结probe只以最近`complete`探针执行45分钟门禁；最近complete仍为`2026-07-16T01:54:29Z`。因此在两层`lockf`内只运行一次新时间戳`forward-probe-v5.mts`，未覆盖或清理上一失败链。
- 新run `forward-v5/probes/2026-07-29T04-54-57-000Z`状态`incomplete_fail_closed`，summary SHA `92251366566ca3911011d04f9fb12e2673719b461a1167f8836c2fb090ba9e44`：三候选首个官方TRADE页再次全部超时，未发布候选evidence，0条可用新增TRADE/REDEEM。禁止清理、重跑、intake、replay或event gate。
- 正式累计账本、淘汰表与保留池不变：`pathf56_14`、`pathf6_03`、`pathf42_04`；ACTIVE新买0/6。正式样本、PnL、胜率、PF、回撤仍不可评估，找到=否；preview/deploy/live/remote写入0，8080未触碰。
- 冻结finalizer `8beb8e0c...`在双锁内原子重建根manifest；6220 listed/actual、0 mismatch，manifest SHA `1b940f44c54d811644fc1209fde9074f2b1a2dce91306bb4f6d3d89a31706105`。

Current run time: 2026-07-29 12:56 CST (about 3 minutes).

## 2026-07-29 13:54–13:57 CST

- 当前`2026-07-29T05:54:13Z`处于当日正式cutoff `05:51:13Z`后15分钟内；两份memory已完整读取，冻结probe/controller/collector/cumulative replay/event gate及baseline/policy/formal-method SHA全部匹配。无在途正式进程、staging/temp或无summary孤儿；未运行probe。
- 在要求的两层`lockf`内只运行一次冻结`forward-formal-window-controller-v5.mts`。总控选择尚未封存的首窗`window-000001`（`2026-07-15T21:51:13Z`–`2026-07-16T21:51:13Z`），collector因实际fetch start晚`1,065,798,486ms`，超过冻结15分钟上限，原子发布`incomplete_fail_closed`后退出；replay/event gate被禁止。
- Collector summary/seal SHA分别`6664bd3c6b0957209b7c2f5375d452776f7ef4ff44cdc81e449a0846b2447b7a` / `3b177a7a1f7e4c137f1773b37b4696396722a0e308eb5d20786ebfe1957131e4`。三候选均`error_fail_closed`，无候选输入、无`results-v5/seal.json`、无正式PnL；该失败链必须保留，不清理、不重跑、不降级到probe。
- 正式累计账本、淘汰表和保留池不变：`pathf56_14`、`pathf6_03`、`pathf42_04`；ACTIVE新买0/6。正式样本、PnL、胜率、PF、回撤仍不可评估，找到=否；preview/deploy/live/remote写入0，8080未触碰。
- 冻结finalizer `8beb8e0c...`在双锁内原子重建根manifest；6222 listed/actual、0 mismatch，manifest SHA `e09f2d1f8109993ed382197717420ad2739be6dcc695ede13e796392ae5d7fea`。

Current run time: 2026-07-29 13:57 CST (about 3 minutes).

## 2026-07-29 14:52–14:55 CST

- 当前`2026-07-29T06:52Z`不在正式cutoff后15分钟内；两份memory与artifact authority已核对。冻结probe/controller/collector/cumulative replay/event gate及baseline/policy/formal-method SHA全部匹配。上一正式`window-000001`迟到失败链保持只读；无在途进程、残留锁、staging/temp或无summary孤儿，`results-v5/seal.json`仍不存在。
- 最近complete probe仍为`2026-07-16T01:54:29Z`，已超过45分钟。在两层`lockf`内只运行一次冻结`forward-probe-v5.mts`，未覆盖或清理既有失败证据。
- 新run `forward-v5/probes/2026-07-29T06-53-32-000Z`状态`incomplete_fail_closed`，summary SHA `418c505d9de0d83f98d99d3a1d437f419a67a3cba6b23f6521f6869bc20e4c56`：三候选首个官方TRADE页均超时，未发布候选evidence，0条可用新增TRADE/REDEEM。禁止清理、重跑、intake、replay或event gate。
- 正式累计账本、淘汰表与保留池不变：`pathf56_14`、`pathf6_03`、`pathf42_04`；ACTIVE新买0/6。正式样本、PnL、胜率、PF、回撤仍不可评估，找到=否；preview/deploy/live/remote写入0，8080未触碰。
- 冻结finalizer `8beb8e0c...`在双锁内原子重建根manifest；6223 listed/actual、0 mismatch，manifest SHA `fb0e0850354fe2a848f5726a1642e1b7c6ce71c0b9e986eb41caa372e6388029`。

Current run time: 2026-07-29 14:55 CST (about 3 minutes).

## 2026-07-29 15:54–15:57 CST

- 当前`2026-07-29T07:54Z`不在正式cutoff后15分钟内；两份memory已完整读取。冻结probe/controller/collector/cumulative replay/event gate及baseline/policy/formal-method SHA全部匹配。上一正式`window-000001`迟到失败链保持只读；无在途进程、持锁、staging/temp或无summary孤儿，`results-v5/seal.json`仍不存在。
- 最近complete probe仍为`2026-07-16T01:54:29Z`，已超过45分钟。在要求的两层`lockf`内只运行一次冻结`forward-probe-v5.mts`，未覆盖或清理既有失败证据。
- 新run `forward-v5/probes/2026-07-29T07-55-30-000Z`状态`incomplete_fail_closed`，summary SHA `c0b5d85f1072914e62749a5c9eaf6170a97f2bb573300aa37a6a2654c7b809f9`：三候选首个官方TRADE页均超时，未发布候选evidence，0条可用新增TRADE/REDEEM。禁止清理、重跑、intake、replay或event gate。
- 正式累计账本、淘汰表与保留池不变：`pathf56_14`、`pathf6_03`、`pathf42_04`；ACTIVE新买0/6。正式样本、PnL、胜率、PF、回撤仍不可评估，找到=否；preview/deploy/live/remote写入0，8080未触碰。
- 冻结finalizer `8beb8e0c...`在双锁内原子重建根manifest；6224 listed/actual、0 mismatch，manifest SHA `77d147350f0ef89e8737534eb7bfc2338ccf661f9f9f2b591f51ff7110d2691c`。

Current run time: 2026-07-29 15:57 CST (about 3 minutes).

## 2026-07-29 16:54–16:57 CST

- 当前`2026-07-29T08:54Z`不在正式cutoff后15分钟内；两份memory与artifact authority已完整核对。冻结probe/controller/collector/cumulative replay/event gate及baseline/policy/formal-method SHA全部匹配。`window-000001`迟到失败链保持只读；无在途进程、probe.lock、staging/temp或无summary孤儿，且仍无`results-v5/seal.json`。
- 最近complete probe仍为`2026-07-16T01:54:29Z`，已超过45分钟。在两层`lockf`内只运行一次冻结`forward-probe-v5.mts`，未覆盖或清理既有失败证据。
- 新run `forward-v5/probes/2026-07-29T08-55-05-000Z`状态`incomplete_fail_closed`，summary SHA `f71173f5945e529300ac98116497c1be9e785cf6f26ea46dec5ff5d7d6b0d184`：三候选首个官方TRADE页均超时，未发布候选evidence，0条可用新增TRADE/REDEEM。禁止清理、重跑、intake、replay或event gate。
- 正式累计账本、淘汰表与保留池不变：`pathf56_14`、`pathf6_03`、`pathf42_04`；ACTIVE新买0/6。正式样本、PnL、胜率、PF、回撤仍不可评估，找到=否；preview/deploy/live/remote写入0，8080未触碰。
- 冻结finalizer `8beb8e0c...`在双锁内原子重建根manifest；6225 listed/actual、0 missing/extra/hash或bytes mismatch，manifest SHA `fb3f933056da5cd1d9c682f28c01dca21b32a144b6b226085f7068d31d3cfdbb`。

Current run time: 2026-07-29 16:57 CST (about 3 minutes).

## 2026-07-29 17:54–17:57 CST

- 当前`2026-07-29T09:54Z`不在正式cutoff后15分钟内；两份memory与artifact authority已完整核对。冻结probe/controller/collector/cumulative replay/event gate及baseline/policy/formal-method SHA全部匹配。`window-000001`迟到失败链保持只读；无在途进程、probe.lock、staging/temp或无summary孤儿，且仍无`results-v5/seal.json`。
- 最近complete probe仍为`2026-07-16T01:54:29Z`，已超过45分钟。在两层`lockf`内只运行一次冻结`forward-probe-v5.mts`，未覆盖或清理既有失败证据。
- 新run `forward-v5/probes/2026-07-29T09-54-43-000Z`状态`incomplete_fail_closed`，summary SHA `39b481eff55b450a5fdfb0817aa13d23045acff1c91dd64973942fa2cbd0b500`：三候选首个官方TRADE页均超时，未发布候选evidence，0条可用新增TRADE/REDEEM。禁止清理、重跑、intake、replay或event gate。
- 正式累计账本、淘汰表与保留池不变：`pathf56_14`、`pathf6_03`、`pathf42_04`；ACTIVE新买0/6。正式样本、PnL、胜率、PF、回撤仍不可评估，找到=否；preview/deploy/live/remote写入0，8080未触碰。
- 冻结finalizer `8beb8e0c...`在双锁内原子重建根manifest；6226 listed/actual、0 missing/extra/hash mismatch，manifest SHA `d5503f42e6e3b7b0353ffa1ba853e297f110271d08855c25b5392030351ec3f2`。

Current run time: 2026-07-29 17:57 CST (about 3 minutes).

## 2026-07-29 18:54–18:56 CST

- 当前`2026-07-29T10:54Z`不在统一T0推导的正式cutoff后15分钟内；两份memory与artifact authority已完整核对。冻结strict replay、普通controller、event gate、probe、正式controller/collector/cumulative replay/event gate及baseline/policy/formal-method SHA全部匹配。`window-000001`迟到失败链保持只读；无在途进程、probe.lock、staging/temp或无summary孤儿，且仍无`results-v5/seal.json`。
- 最近complete probe仍为`2026-07-16T01:54:29Z`，已超过45分钟。在要求的两层`lockf`内只运行一次冻结`forward-probe-v5.mts`，未覆盖或清理既有失败证据。
- 新run `forward-v5/probes/2026-07-29T10-54-59-000Z`状态`incomplete_fail_closed`，summary SHA `a5273dc068bf8ba5a08e94f3b3e53edb84c7b8f648997defa88a5a268a614e69`：三候选首个官方TRADE页均超时，未发布候选evidence，0条可用新增TRADE/REDEEM。禁止清理、重跑、intake、replay或event gate。
- 正式累计账本、淘汰表与保留池不变：`pathf56_14`、`pathf6_03`、`pathf42_04`；ACTIVE新买0/6。正式样本、PnL、胜率、PF、回撤仍不可评估，找到=否；preview/deploy/live/remote写入0，8080未触碰。
- 冻结finalizer `8beb8e0c...`在双锁内原子重建根manifest；6227 listed/actual、0 missing/extra/hash/bytes mismatch，manifest SHA `9a2d68d4b81c9743dca42d3fa18c1619292f87f1fd1f9da6f784be5563a36971`。

Current run time: 2026-07-29 18:56 CST (about 2 minutes).

Automation run: 2026-07-29 19:52–19:55 CST (2026-07-29T11:52–11:55Z)

- This run was outside the formal cutoff's first15 minutes. Both memories and artifact authority were fully read; all frozen strict replay, ordinary controller, event gate, probe/formal controller, collector, cumulative replay/event gate and baseline/policy/method SHAs matched. The late `window-000001` failure remains read-only; no running process, probe lock, staging/temp directory or summary-less orphan existed. `results-v5/seal.json` remained absent.
- The latest complete probe remained `2026-07-16T01:54:29Z`, over45 minutes old. Ran exactly one frozen `forward-probe-v5.mts` under both required `lockf` layers without modifying prior failed evidence.
- Run `forward-v5/probes/2026-07-29T11-53-47-000Z` sealed `incomplete_fail_closed`, summary SHA `5de7a942de2b89d81e4119e9cd83e4d4b15006a7db948994cf0eab6774f0d0b6`: all three candidates timed out on their first official TRADE page. No candidate evidence was published and0 usable TRADE/REDEEM rows were produced. Preserve it; do not clean, rerun, intake, replay or event-gate.
- Formal cumulative ledger/eliminations remain unchanged. Retained pool is `pathf56_14`, `pathf6_03`, `pathf42_04`; ACTIVE new-buy0/6. Formal sample, PnL, win rate, PF and drawdown remain non-evaluable; found=no. Preview/deploy/live/remote writes0; production8080 untouched.
- Rebuilt the root manifest atomically under both locks with frozen finalizer `8beb8e0c...`; full verification found6228 listed/actual files and0 missing/extra/hash/byte mismatches. Manifest SHA `c4f48c07d3833e0484b8a217be7e6473cac8980120d25928ab654472b5fa79dd`.

Current run time: 2026-07-29 19:55 CST (about 3 minutes).

## 2026-08-24 09:53–09:57 CST

- 当前权威隔离运行目录为 `/Users/kaijimima1234/Desktop/polymirror/reports/preview-pipeline/20260824T012032Z`，健康端口 `18080`；preview daemon PID 69377 与小时 collector PID 69596 均持续运行，未恢复/重启，生产 8080 未触碰。
- 18080 三次复核均 `status=ok` / `previewMode=true`，9/9 账户已轮询；pending=0、wallet drift=[]、settlement failure=0、closed-market open position=0、capacity=OK（预计约 4488 天）。首次健康读取曾出现 `pathf42_04` FIXED5 报价覆盖 0 导致的瞬时 14.99% 保守回撤；后续报价恢复为 100%，权益 198.181817U、清算回撤 0.909092%，未触发 kill/retire。
- 9 份连续 SQLite 账本全部 `quick_check=ok`、对账 delta=0、pending/live intent/unresolved settlement failure=0。当前仅 `pathf42_04` FIXED5 有 6 COPY、0 SELL、0 REDEEM，cash 170.0261U、open cost 29.9739U、6 个开放 condition；其余 8 账户无 COPY/SELL/REDEEM，cash 均 200U。Gamma 官方复核这 6 个 condition 全部 `closed=false` / `acceptingOrders=true` / `closedTime=null`，不得计入已结算样本。
- 最新有效原生报告 `/Users/kaijimima1234/Desktop/polymirror/reports/preview-pipeline/20260824T012032Z/reports/preview-report-2026-08-24T01-56-18-527Z.json`（SHA256 `c340b57d75e50b4a9d719e1fa5aa4379dbee25b90666202101bc13ee2511a259`）；cohort `/Users/kaijimima1234/Desktop/polymirror/reports/preview-pipeline/20260824T012032Z/reports/preview-cohort-table-2026-08-24T01-56-18-920Z.json`（SHA256 `3a87cf656bb5ba794624342b1c1e5007723ebe25962a966267409a1f19004a88`）。汇总：9 账户、6 COPY、0 REDEEM、realized PnL 0U、cash 1770.03U、open cost 29.97U、liveReady=0。
- 所有 leader/FIXED 1U/2U/5U 的官方已结算 event 均为 0，PF、胜率、已实现回撤、Top3 集中度、去 Top1/2/3 PnL、日 PnL 相关性与 event 重合均不可评估；映射覆盖因 0 REDEEM 为无样本，不得冒充 100% 达标。无淘汰、无新候选、无实盘；**尚未稳定盈利**。
- 手动单次 collector 首次因漏传隔离 `CONFIG_PATH` 生成范围无效报告 `preview-report-2026-08-24T01-55-38-956Z.json`（SHA256 `3e10f1f4444d66513ac365dcf0f21d29213b94bffe51415d0d63599967269c8c`，27 账户/18 missingDb，cohort fail-closed）；已原样保留且不作权威证据。随后使用隔离 config 单次收集成功，未影响持续 collector。

Current run time: 2026-08-24 09:57 CST (about 4 minutes).


## 2026-08-24 10:39–11:08 CST — AWS research reset and mass preview

- User explicitly authorized a full remote research reset. Created EBS rollback snapshot `snap-01352f7c9f707844e` for volume `vol-0ce653c069e85d09c`, then stopped/removed all 8 legacy Docker containers, pruned legacy images/networks, and deleted only the old contents of `/opt/polymirror`. Snapshot remained pending but point-in-time frozen; no other host directory was deleted.
- AWS authority: profile `cenxi`, region `eu-west-1`, instance `i-04d5b63abed72912b` (`c7i-flex.large`, 2 vCPU, 3.7GiB RAM, 80GiB gp3). Before reset: load ~3.4, 3670 zombies, 35GB under /opt/polymirror, 12.1GB/28 DBs, 34GB free. After reset/build: old services gone, 69GB free, swap use reduced from883MiB to ~139MiB.
- Fresh GitHub deployment is branch `codex/polymirror-stability-checkpoint-20260710`, runtime revision `4a89e0748b066e6063cab6f64e5481d0824deb0a`, official `@polymarket/client 0.6.0`. Builder/runtime Docker images are tagged by exact revision.
- Official discovery root: `/opt/polymirror/research/mass-20260824-v1`. Captured 6000 official leaderboard rows over 10 categories × DAY/WEEK/MONTH ×4 pages; froze500 unique wallets, SHA manifest under `discovery/manifest.json`; sharded to50×10-candidate artifacts.
- First live-forward simulation uses top50 Leaders × FIXED1/2/5 =150 isolated preview accounts in one process, `config.mass-preview.yaml`; all data/reports remain remote under the research root. Official Activity fetches are shared across the three arms per Leader.
- Initial serial cycle completed148/150 and captured234 preview orders; only Balthazar standard/aggressive failed closed on a duplicate terminal-decision invariant. Added and deployed bounded six-way account concurrency. Post-upgrade verification: health OK, preview-only,150/150 polled, lastError=null, pending0, settlement failures0, wallet drifts[], capacity OK;573 account polls and293 preview copies observed, container memory ~669MiB, host load0.92.
- First report `reports/preview-report-2026-08-24T03-01-03-467Z.json` was generated during warm-up:150 accounts,3 copies,0 redeem, realized0U, open cost7.98U, liveReady0. It is an early baseline; next hourly reports are authoritative for continuing state. **Stable profitability remains unproven; no live trading.**
