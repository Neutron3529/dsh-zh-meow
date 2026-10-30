/**
 * 喵体中文的设置页（浏览器半侧）。
 *
 * 这是一个手写的 lazy-CJS 客户端 bundle：DSH 的客户端模块系统加载
 * `./client` 导出后，只执行 factory 注册，模块副作用在物化时运行。这里不依赖
 * 任何构建工具，也不引用第三方全家桶，只使用基座的 `react` 与官方
 * `settings.section` / `configForms` 能力。
 *
 * 页面读写 profile 顶层条目 `meow-team-config` 的 volatile 字段：
 *   - `ptc`（编码模式：PTC / 原生）
 *   - `coder.model` / `coder.effort`
 *   - `verifiers[]`（id、enabled、model、effort、mode）
 *
 * 模型与强度留空表示继承父 agent；保存即时生效。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-zh-meow',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'settings.meowTeam'
    const ENTRY_ID = 'meow-team-config'
    const EFFORTS = ['', 'off', 'low', 'high', 'max']

    const DICTS = {
      zh: {
        title: '喵体中文',
        note: '这里的配置对团队流程生效；保存后下一轮对话就会使用新配置。模型与强度留空表示继承 DSH 当前设置。',
        executor: '编码模式',
        ptc: 'PTC 模式（模型写 run_code 程序来调工具）',
        ptcHint: '默认开启：模型把多次工具调用写进一段程序，中间结果不占对话上下文。关掉则逐次直接调用工具。管家固定用原生模式（它没有命令工具，PTC 的 Node 能力会绕开它的边界）。宿主没有挂 PTC runtime 时自动退回原生模式。切换在下一轮生效。',
        steward: '管家',
        stewardHint: '模型与强度继承 DSH 当前设置（在会话模型选择器里修改）。',
        coder: '码农',
        verifiers: '独立校验者',
        add: '添加校验者',
        remove: '删除',
        enabled: '启用',
        model: '模型',
        effort: '强度',
        mode: '模式',
        inherit: '（继承）',
        modelPlaceholder: '留空 = 继承（或写 provider/model）',
        emptyVerifiers: '未启用校验者：管家会直接采用码农交付。',
        unavailable: '设置服务不可用，无法读取配置。',
        loading: '正在读取配置…',
        saveFailed: '保存失败，请重试。',
        modeTwoRound: '两轮（先任务后问答）',
        modeOneShot: '一次拿全',
      },
      en: {
        title: 'Meow Chinese',
        note: 'Applies to the team workflow. Leave model or effort empty to inherit the DSH setting; the next turn picks up saved changes.',
        executor: 'Coding mode',
        ptc: 'PTC mode (the model writes run_code programs to call tools)',
        ptcHint: 'On by default: the model folds several tool calls into one program, so intermediate results stay out of the conversation. Turn it off to call tools one by one. The steward always uses native mode (it has no shell, and PTC Node access would bypass its boundaries). Without a PTC runtime the plugin falls back to native mode. Changes apply on the next turn.',
        steward: 'Steward',
        stewardHint: 'Model and effort inherit the current DSH session setting (change it in the session model picker).',
        coder: 'Coder',
        verifiers: 'Independent verifiers',
        add: 'Add verifier',
        remove: 'Remove',
        enabled: 'Enabled',
        model: 'Model',
        effort: 'Effort',
        mode: 'Mode',
        inherit: '(inherit)',
        modelPlaceholder: 'Empty = inherit (or provider/model)',
        emptyVerifiers: 'No verifier enabled: the steward will accept the coder\'s delivery directly.',
        unavailable: 'Settings service unavailable.',
        loading: 'Loading settings…',
        saveFailed: 'Save failed. Try again.',
        modeTwoRound: 'Two rounds (task first, answers later)',
        modeOneShot: 'One shot (everything at once)',
      },
    }

    const inputStyle = {
      minWidth: '220px',
      padding: '4px 8px',
      border: '1px solid rgba(127,127,127,0.45)',
      borderRadius: '6px',
      background: 'transparent',
      color: 'inherit',
      fontSize: '13px',
    }
    const selectStyle = { ...inputStyle, minWidth: '110px' }
    const rowStyle = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }
    const labelStyle = { fontSize: '12px', opacity: 0.75 }
    const hintStyle = { fontSize: '12px', opacity: 0.65, lineHeight: 1.5 }
    const sectionStyle = {
      display: 'grid',
      gap: '10px',
      padding: '12px 14px',
      border: '1px solid rgba(127,127,127,0.22)',
      borderRadius: '10px',
    }
    const titleStyle = { fontSize: '13px', fontWeight: 600 }
    const buttonStyle = {
      padding: '4px 10px',
      border: '1px solid rgba(127,127,127,0.45)',
      borderRadius: '6px',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      fontSize: '12px',
    }

    /**
     * 订阅共享设置表单。
     *
     * `configForms.get()` 返回的是带 `this` 的控制器实例，直接把
     * `form.subscribe` / `form.getSnapshot` 当函数传进 React 会丢 `this`；
     * 所以由 apply 闭包提供已经绑定好的两个函数。
     * @param props - 槽位 props，含 `subscribe` 与 `getSnapshot`。
     * @returns 当前快照。
     */
    function useForm(props) {
      return React.useSyncExternalStore(props.subscribe, props.getSnapshot, props.getSnapshot)
    }

    /**
     * 渲染设置卡片。
     * @param props - 槽位 props，含 `form`、绑定好的订阅函数与本地化 `t`。
     * @returns 设置页元素树。
     */
    function MeowTeamSettings(props) {
      const form = props.form
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const snapshot = useForm(props)
      const [failure, setFailure] = React.useState('')

      const save = (field, next) => {
        setFailure('')
        form.set(field, next).then((accepted) => {
          if (!accepted) setFailure(t('saveFailed'))
        }).catch(() => { setFailure(t('saveFailed')) })
      }

      if (snapshot.status === 'loading') return h('div', { style: hintStyle }, t('loading'))
      if (snapshot.status === 'unavailable' || snapshot.value === undefined) {
        return h('div', { style: hintStyle }, t('unavailable'))
      }

      const writable = snapshot.writable === true
      const coder = snapshot.value.coder ?? { model: '', effort: 'low' }
      const verifiers = Array.isArray(snapshot.value.verifiers) ? snapshot.value.verifiers : []
      // 缺省即开启：老配置里没有这个字段时，PTC 模式照旧生效。
      const ptc = snapshot.value.ptc !== false

      const updateCoder = (patch) => { save('coder', { ...coder, ...patch }) }
      const setVerifiers = (next) => { save('verifiers', next) }
      const updateVerifier = (index, patch) => {
        setVerifiers(verifiers.map((item, at) => at === index ? { ...item, ...patch } : item))
      }
      const removeVerifier = (index) => {
        setVerifiers(verifiers.filter((_item, at) => at !== index))
      }
      const addVerifier = () => {
        const used = new Set(verifiers.map(item => item.id))
        let number = 1
        while (used.has(`v${number}`)) number += 1
        setVerifiers([...verifiers, { id: `v${number}`, enabled: true, model: '', effort: 'high', mode: 'one-shot' }])
      }

      const effortOptions = (current) => {
        const options = EFFORTS.slice()
        if (typeof current === 'string' && current.length > 0 && !options.includes(current)) options.push(current)
        return options
      }

      return h('div', { style: { display: 'grid', gap: '16px', padding: '4px 2px' } },
        h('div', { style: hintStyle }, t('note')),

        h('section', { style: sectionStyle },
          h('div', { style: titleStyle }, t('executor')),
          h('div', { style: rowStyle },
            h('input', {
              type: 'checkbox',
              checked: ptc,
              disabled: !writable,
              onChange: (event) => { save('ptc', event.target.checked) },
            }),
            h('span', { style: labelStyle }, t('ptc')),
          ),
          h('div', { style: hintStyle }, t('ptcHint')),
        ),

        h('section', { style: sectionStyle },
          h('div', { style: titleStyle }, t('steward')),
          h('div', { style: hintStyle }, t('stewardHint')),
        ),

        h('section', { style: sectionStyle },
          h('div', { style: titleStyle }, t('coder')),
          h('div', { style: rowStyle },
            h('span', { style: labelStyle }, t('model')),
            h('input', {
              key: `coder-model-${snapshot.revision}`,
              defaultValue: coder.model ?? '',
              placeholder: t('modelPlaceholder'),
              disabled: !writable,
              style: inputStyle,
              onBlur: (event) => { updateCoder({ model: event.target.value }) },
            }),
            h('span', { style: labelStyle }, t('effort')),
            h('select', {
              value: coder.effort ?? '',
              disabled: !writable,
              style: selectStyle,
              onChange: (event) => { updateCoder({ effort: event.target.value }) },
            }, effortOptions(coder.effort).map(value => h('option', { key: `coder-${value}`, value },
              value === '' ? t('inherit') : value))),
          ),
        ),

        h('section', { style: sectionStyle },
          h('div', { style: titleStyle }, t('verifiers')),
          verifiers.length === 0
            ? h('div', { style: hintStyle }, t('emptyVerifiers'))
            : null,
          verifiers.map((verifier, index) => h('div', { key: verifier.id ?? index, style: rowStyle },
            h('input', {
              type: 'checkbox',
              checked: verifier.enabled !== false,
              disabled: !writable,
              onChange: (event) => { updateVerifier(index, { enabled: event.target.checked }) },
              title: t('enabled'),
            }),
            h('span', { style: { ...labelStyle, minWidth: '28px' } }, verifier.id),
            h('input', {
              key: `verifier-${verifier.id}-${snapshot.revision}`,
              defaultValue: verifier.model ?? '',
              placeholder: t('modelPlaceholder'),
              disabled: !writable,
              style: inputStyle,
              onBlur: (event) => { updateVerifier(index, { model: event.target.value }) },
            }),
            h('select', {
              value: verifier.effort ?? '',
              disabled: !writable,
              style: selectStyle,
              onChange: (event) => { updateVerifier(index, { effort: event.target.value }) },
            }, effortOptions(verifier.effort).map(value => h('option', { key: `verifier-${value}`, value },
              value === '' ? t('inherit') : value))),
            h('select', {
              value: verifier.mode ?? 'one-shot',
              disabled: !writable,
              style: { ...selectStyle, minWidth: '180px' },
              onChange: (event) => { updateVerifier(index, { mode: event.target.value }) },
            },
            h('option', { value: 'two-round' }, t('modeTwoRound')),
            h('option', { value: 'one-shot' }, t('modeOneShot'))),
            h('button', {
              type: 'button',
              style: buttonStyle,
              disabled: !writable,
              onClick: () => { removeVerifier(index) },
            }, t('remove')),
          )),
          h('div', {},
            h('button', {
              type: 'button',
              style: buttonStyle,
              disabled: !writable,
              onClick: addVerifier,
            }, t('add')),
          ),
        ),

        failure.length > 0 ? h('div', { style: { ...hintStyle, color: '#e06c75' } }, failure) : null,
      )
    }

    /**
     * 浏览器半侧插件入口。
     * @param ctx - 客户端插件 context。
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, DICTS), 'zh-meow: settings locale')
      const form = ctx.configForms.get(ENTRY_ID)
      const subscribe = (listener) => form.subscribe(listener)
      const getSnapshot = () => form.getSnapshot()
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'meow-team',
        order: 30,
        label: () => t('title'),
        locale: NS,
        inject: () => ({ form, subscribe, getSnapshot }),
      }, MeowTeamSettings)), 'zh-meow: settings section')
    }

    return { inject: ['slots', 'locale', 'configForms'], apply }
  },
})
