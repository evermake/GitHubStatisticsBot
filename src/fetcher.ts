import type { Octokit } from 'octokit'
import type { GitHubStats } from './common'

export class StatsFetcher {
  constructor(private octokit: Octokit) {}

  public async getUserStats(username: string): Promise<GitHubStats> {
    const user = (await this.octokit.rest.users.getByUsername({ username })).data

    const repos = await this.octokit.paginate(
      this.octokit.rest.repos.listForUser,
      {
        username,
        sort: 'created',
        direction: 'desc',
        per_page: 100,
      },
      response => response.data.map(({ stargazers_count }) => ({ stars: stargazers_count ?? 0 })),
    )
    const stars = repos.reduce((acc, { stars }) => acc + stars, 0)
    const commits = await this.octokit.rest.search.commits({
      q: `author:${username}`,
      per_page: 1,
    })
    const prs = await this.octokit.rest.search.issuesAndPullRequests({
      advanced_search: 'true',
      q: `author:${username} is:pr`,
      per_page: 1,
    })
    const issues = await this.octokit.rest.search.issuesAndPullRequests({
      advanced_search: 'true',
      q: `author:${username} is:issue`,
      per_page: 1,
    })

    return {
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
  }
}
