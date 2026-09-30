# 用 `oc` 分析 `oc` 自己

> 这份文档不是宣传，是一次真实的自检。
> 所有数字都是 `oc` 在自己的仓库上跑出来的，未经修饰 ——
> 包括那条让作者不太高兴的发现。

```bash
git clone https://github.com/gupi-bill/repo-intelligence
cd repo-intelligence
node bin/oc.mjs
```

## 总评

```
Health 76 / 100   grade B
```

37 个源文件，全历史模式，耗时 0.8 秒。

## 六个分项

| 分项 | 分数 | `oc` 说的原话 |
|------|------|---------------|
| Maintainability | **94** | median 2.6 decision points per function |
| Structure | **100** | 0 import cycles touching 0 files |
| Change concentration | **100** | most-changed 10% of files account for a small share |
| Debt load | **98** | 0.4 markers per 1k lines |
| Test coverage | 74 | 13/28 source files reached by a test (46%) |
| Maintenance cadence | **17** | 1 of the last 6 months have commits |

## 三个值得说的地方

### 分项之间差距比总分有用

总分 76 是个和稀泥的数字，看不出该干什么。
但拆开之后画面清楚多了：

- **Structure 100 / Maintainability 94 / Debt 98** —— 代码本身是干净的。
  没有循环依赖，函数不长，`TODO`/`FIXME` 几乎没有。
- **Cadence 17** —— 最近六个月只有一个月有提交。
  这不是代码问题，是「项目还活着吗」的问题。
- **Test coverage 74（46%）** —— 28 个源文件里 13 个被测试碰到过。

**知道该修什么，比知道「我有多少分」有用。**

### 找出真热点

`oc` 把复杂度、深度、改动频次揉成一个 risk 分。排在最前的几个：

| 文件 | risk | complexity | 函数数 | perFunction |
|------|------|-----------|--------|-------------|
| `src/core/scan.mjs` | 69 | 74 | 18 | 4.11 |
| `src/analyze/report.mjs` | 63 | **136** | 11 | **12.36** |
| `src/core/workspace.mjs` | 59 | 27 | 7 | 3.86 |
| `src/cli.mjs` | 58 | 92 | 18 | 5.11 |

`report.mjs` 的 **12.36 决策点/函数** 明显是离群值。
另外三个都在 4~5 之间。**离群值比平均值有用** ——
它直接指出「这个函数该拆了」，而不是「你的代码平均有点复杂」。

### bus factor = 1

```
1 of 1 authors active in the last 6 months
busFactor: 1
```

一个人写的项目，这是事实而不是缺陷。
但它说明了一件事：**这个仓库没有第二个人真的读过它的历史。**
所以 bus factor 该指标在这里的正确用法不是「找人分担」，
而是「写文档」。这也是 README 里 limitations 写得那么长的原因 ——
它得让陌生人也能上手。

## 局限：这份文档本身也是例子

`oc` 自己在 README 的 Limitations 里列了六条。这个仓库的数据正好踩中三条：

| 局限 | 在这份数据里的表现 |
|------|-------------------|
| **Ownership comes from `git log` authors** | 只有一个作者，所以 ownership 50 分其实说明不了任何问题 —— 一人仓库的 bus factor 恒等于 1 |
| **Churn counts commits, not effort** | 这个仓库总共 5 个提交，所有 churn 数字的样本量小到不该当真 |
| **Test reach is a proxy** | 46% 是「测试文件里 import 过这个源文件」，不是覆盖率的行覆盖。`scan.mjs` 有 18 个函数，被一个测试 import 过一次就会被算成「已覆盖」 |

**换句话说：这个仓库太小了，`oc` 在它身上的结论只能当烟雾报警器，
不能当体检报告。** 这也是 README 里写明「a metrics tool that oversells
itself is worse than none」的原因。

真要用它做决策，去跑一个大点的、老一点的仓库 ——
`oc` 值得被信任的前提是它有足够的历史可以看。

## 顺带

`oc` 也可以挂在 CI 上做门禁：

```bash
node bin/oc.mjs --json > health.json
# health 低于阈值就 exit 1
```

作者的用法是挂在 pre-commit 上，但如果你要设阈值，
建议先用 `--since` 限定窗口，避免因为「上个月没人提交」而天天红。
