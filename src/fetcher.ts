import type { Octokit } from 'octokit'
import type { GitHubStats } from './common'
import { TaskQueue } from './task_queue'

export interface Task {
  username: string
}

export interface Payload {
  stats: GitHubStats
}

export function makeFetcher<M>(octokit: Octokit) {
  return new TaskQueue<Task, Payload, M>(
    async ({ username }, meta) => {
      const user = (await octokit.rest.users.getByUsername({ username })).data

      const repos = await octokit.paginate(
        octokit.rest.repos.listForUser,
        {
          username,
          sort: 'created',
          direction: 'desc',
          per_page: 100,
        },
        response => response.data.map(({ stargazers_count }) => ({ stars: stargazers_count ?? 0 })),
      )
      const stars = repos.reduce((acc, { stars }) => acc + stars, 0)
      const commits = await octokit.rest.search.commits({
        q: `author:${username}`,
        per_page: 1,
      })
      const prs = await octokit.rest.search.issuesAndPullRequests({
        advanced_search: 'true',
        q: `author:${username} is:pr`,
        per_page: 1,
      })
      const issues = await octokit.rest.search.issuesAndPullRequests({
        advanced_search: 'true',
        q: `author:${username} is:issue`,
        per_page: 1,
      })

      const stats = {
        avatarUrl: user.avatar_url,
        fullname: user.name ?? '',
        username,
        joinDate: new Date(user.created_at),
        commits: commits.data.total_count,
        stars,
        followers: user.followers,
        pullRequests: prs.data.total_count,
        issues: issues.data.total_count,
        repos: user.public_repos,
      }

      return { stats, meta }
    },
  )
}
