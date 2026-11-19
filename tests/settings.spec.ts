import { describe, expect, it } from 'vitest'
import { allowLogin, pointSource, prepareCommand, roleModel, seedExecutor, seedModel } from '../src/settings-api.ts'

const policy = {
  rules: [{ id: 'r1', name: 'Requests', instruction: 'take it', enabled: true, strength: 'explicit' }],
  sources: { github: { allowed: [{ id: 'demo-operator' }], bots: [{ id: 'dependabot[bot]' }] } },
}

describe('allowLogin', () => {
  it('adds a login while keeping the rest of the policy', () => {
    const next = allowLogin(policy, 'new-person') as typeof policy
    expect(next.sources.github.allowed).toEqual([{ id: 'demo-operator' }, { id: 'new-person' }])
    expect(next.rules).toEqual(policy.rules)
    expect(next.sources.github.bots).toEqual(policy.sources.github.bots)
  })

  it('does nothing when the login is already allowed, whatever its case', () => {
    expect(allowLogin(policy, 'demo-operator')).toBeUndefined()
  })

  it('starts a source part that the policy does not have yet', () => {
    const next = allowLogin({ rules: [] }, 'someone') as { sources: { github: { allowed: { id: string }[] } } }
    expect(next.sources.github.allowed).toEqual([{ id: 'someone' }])
  })
})

describe('pointSource', () => {
  it('writes the repository, the agent CLI, and the observation switches, and turns the source on', () => {
    const next = pointSource({ enabled: false, config: { repository: 'old/repo', pollSeconds: 60 } },
      'owner/new', '/root/.local/bin/gh-agent')
    expect(next).toEqual({ enabled: true, config: { repository: 'owner/new', pollSeconds: 60,
      cli: '/root/.local/bin/gh-agent', observeIssues: true, observeComments: true } })
  })

  it('adds the observation switches to a source that already points at the repository', () => {
    const next = pointSource({ enabled: true, config: { repository: 'owner/repo', cli: '/cli' } }, 'owner/repo', '/cli')
    expect(next).toMatchObject({ enabled: true, config: { observeIssues: true, observeComments: true } })
  })

  it('does nothing when every field already matches', () => {
    const value = { enabled: true,
      config: { repository: 'owner/repo', cli: '/cli', observeIssues: true, observeComments: true } }
    expect(pointSource(value, 'owner/repo', '/cli')).toBeUndefined()
  })
})

describe('prepareCommand', () => {
  it('fetches the ticket ref and cuts a worktree from the clone', () => {
    const command = prepareCommand('/root/src/repo')
    expect(command).toContain('git -C /root/src/repo fetch --no-tags')
    expect(command).toContain('refs/dsh-superagent/$DSH_SUPERAGENT_TICKET')
    expect(command).toContain('git -C /root/src/repo worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR"')
    expect(command).toContain(' && ')
  })
})

const catalog = {
  default: { provider: 'deepseek-official', model: 'deepseek-flash' },
  groups: [{ id: 'deepseek-official', models: [{ id: 'deepseek-flash', reasoning: { efforts: [
    { id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' },
  ] } }] }],
}

describe('the role model defaults', () => {
  it('seeds the deployment default with the requested effort', () => {
    expect(roleModel(catalog, 'low')).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' })
    expect(roleModel(catalog, 'max')).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' })
  })

  it('does not seed an effort the model does not offer', () => {
    expect(roleModel(catalog, 'turbo')).toBeUndefined()
  })

  it('never overwrites a model a person chose', () => {
    const chosen = { model: { provider: 'other', model: 'm' } }
    expect(seedModel(chosen, { provider: 'p', model: 'm', reasoningEffort: 'low' })).toBeUndefined()
    expect(seedModel({ model: null }, { provider: 'p', model: 'm', reasoningEffort: 'low' }))
      .toEqual({ model: { provider: 'p', model: 'm', reasoningEffort: 'low' } })
  })

  it('writes the model and the prepare command in one executor save', () => {
    const next = seedExecutor({ model: null, prepare: '' }, 'git worktree add', roleModel(catalog, 'max')) as Record<string, unknown>
    expect(next.model).toMatchObject({ reasoningEffort: 'max' })
    expect(next.prepare).toBe('git worktree add')
    expect(seedExecutor({ model: { provider: 'p', model: 'm' }, prepare: 'git existing' }, 'new', undefined))
      .toBeUndefined()
  })
})
