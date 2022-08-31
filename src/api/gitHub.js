#!/usr/bin/env node

import fetch from "node-fetch";
import Ora from "ora";
const spinner = Ora();
const githubGraphQL = "https://api.github.com/graphql";
import * as exportCSV from "../services/exportCSV.js";
import fs from "fs";
import { handleStatusError } from "../services/handleStatusError.js";

/**
 * Running PullRequest and issues array
 */
let metrics = [];

/**
 * Valid user credentials
 */
let auth = {};

/**
 * Initial fetched repositories in Organization
 */
let fetched = {};

/**
 * Count number of repo
 */
let count = 0;

/**
 * Org metrics
 */
let orgMetrics = {
  mostPr: 0,
  mostIssues: 0,
};

/**
 * Fetch 100 repositories at a cursor given Orginization and valid PAT
 *
 * @param {string} org the organization
 * @param {string} token the token
 * @param {string} cursor the last repository fetched
 * @param {[Objects]} server the graphql endpoint for a GHES instance
 */
export const fetchRepoInOrg = async (org, token, server, cursor) => {
  return await fetch(await determineGraphQLEndpoint(server), {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
    },
    body: JSON.stringify({
      query: `{
        rateLimit {
          limit
          cost
          remaining
          resetAt
        }
        organization(login: "${org}") {
          repositories(first: 50${cursor}){
            totalCount
            edges {
              cursor
              node {
                projects(first:1){
                  totalCount
                }  
                hasWikiEnabled
                issues(first: 1) {
                  totalCount
                }
                pullRequests(first: 1) {
                  totalCount
                }
                name
                id
                url
                isPrivate
              }
            }
          }
        }
      }`,
    }),
  })
    .then((res) => {
      handleStatusError(res.status);
      return res.json();
    })
    .catch((err) => {
      handleStatusError(500, err);
    });
};

/**
 * Fetch org information
 *
 * @param {string} org the org
 * @param {string} token the token
 * @returns {object} the fetched org information
 */
export const fetchOrgInfo = async (org, server, token) => {
  return await fetch(await determineGraphQLEndpoint(server), {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
    },
    body: JSON.stringify({
      query: `{
        organization(login: "${org}") {
          projects(first: 1) {
            totalCount
          }
          membersWithRole(first: 1) {
            totalCount
          }
        }
      }`,
    }),
  })
    .then((res) => {
      handleStatusError(res.status);
      return res.json();
    })
    .catch((err) => {
      handleStatusError(500);
    });
};

/**
 * Authorize the user with GitHub
 * Continue with fetching metics given successful authorization
 *
 * @param {object} credentials the credentials
 */
export const authorization = async (credentials) => {
  spinner.start("Authorizing with GitHub");
  fetched = await fetchRepoInOrg(
    credentials.organization,
    credentials.token,
    credentials.server, 
    ""
  );

  if (fetched.errors) {
    spinner.fail(` ${fetched.errors[0].message}`);
    process.exit();
  }

  // Successful Authorization
  spinner.succeed("Authorized with GitHub\n");
  auth = credentials;
  await fetchingController(credentials.server);
};

/**
 * Fetching and Storing metrics controller
 * 
 * * @param {[Objects]} server the graphql endpoint for a GHES instance
 */
export const fetchingController = async (server) => {
  //fetching PR and ISSUE metrics
  await fetchRepoMetrics(fetched.data.organization.repositories.edges);

  if (metrics) {
    let org = auth.organization.replace(/\s/g, "");
    await storeRepoMetrics(org);
    await storeOrgMetrics(org, server);
  }
};

/**
 * Fetch PR and ISSUE metrics given list of repositories in org
 *
 * @param {[Objects]} repositories the fetched repositories
 */
export const fetchRepoMetrics = async (repositories) => {
  for (const repo of repositories) {
    spinner.start(
      `(${count}/${fetched.data.organization.repositories.totalCount}) Fetching metrics for repo ${repo.node.name}`
    );
    let repoInfo = {
      name: repo.node.name,
      numOfPullRequests: repo.node.pullRequests.totalCount,
      numOfIssues: repo.node.issues.totalCount,
      numOfProjects: repo.node.projects.totalCount,
      wikiEnabled: repo.node.hasWikiEnabled,
    };
    if (repo.node.pullRequests.totalCount > orgMetrics.mostPr) {
      orgMetrics.mostPr = repo.node.pullRequests.totalCount;
    }
    if (repo.node.projects.totalCount > orgMetrics.mostIssues) {
      orgMetrics.mostIssues = repo.node.projects.totalCount;
    }
    count = count + 1;
    metrics.push(repoInfo);
    spinner.succeed(
      `(${count}/${fetched.data.organization.repositories.totalCount}) Fetching metrics for repo ${repo.node.name}`
    );
  }

  // paginating calls
  // if there are more than 50 repos
  // fetch the next 50 repos
  if (repositories.length === 50) {
    // get cursor to last repository
    spinner.start(
      `(${count}/${fetched.data.organization.repositories.totalCount}) Fetching next 50 repos`
    );
    const cursor = repositories[repositories.length - 1].cursor;
    const result = await fetchRepoInOrg(
      auth.organization,
      auth.token,
      auth.server,
      `, after: "${cursor}"`
    );
    spinner.succeed(
      `(${count}/${fetched.data.organization.repositories.totalCount}) Fetched next 100 repos`
    );
    await fetchRepoMetrics(result.data.organization.repositories.edges);
    return;
  }
};

/**
 * Call CSV service to export repository pull request information
 *
 * @param {String} organization the organization
 * @param {[Object]} data the fetched repositories pr and issue data
 * @param {Object} mostPr the repository with most PR
 * @param {Object} mostIssue the repository with most issues
 */
export const storeRepoMetrics = async (organization) => {
  const dir = `./${organization}-metrics`;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }

  let headers = [
    { id: "name", title: "Repository Name" },
    { id: "numOfPullRequests", title: "Number Of Pull Requests" },
    { id: "numOfIssues", title: "Number of Issues" },
    { id: "numOfProjects", title: "Number of Project" },
    { id: "wikiEnabled", title: "Wiki Enabled" },
  ];

  console.log();
  const path = `${dir}/repo-metrics.csv`;
  spinner.start("Exporting...");
  await exportCSV.csvExporter(path, headers).writeRecords(metrics);
  spinner.succeed(`Exporting Completed: ${path}`);
};


/**
 * Determine if the user is targeting a GHES instance or not. 
 * 
 * * @param {[Objects]} server the graphql endpoint for a GHES instance
 */
export const determineGraphQLEndpoint = async (server) => {
  if (!server) {
    return githubGraphQL;
  } else {
    return server;
  }
};

/**
 * Store Organization information into seperate CSV
 *
 * @param {String} organization the organization name
 * 
 * @param {[Objects]} server the graphql endpoint for a GHES instance
 */
export const storeOrgMetrics = async (organization, server) => {
  const dir = `./${organization}-metrics`;
  const path = `${dir}/org-metrics.csv`;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }

  // Total number of pull-request and issues
  let totalCount = metrics.reduce(
    (prev, current) => {
      return {
        pr: prev.pr + current.numOfPullRequests,
        issue: prev.issue + current.numOfIssues,
      };
    },
    { pr: 0, issue: 0 }
  );

  const orgInfo = await fetchOrgInfo(organization, server, auth.token);
  const storeData = [
    {
      numOfRepos: metrics.length,
      numOfProjects: orgInfo.data.organization.projects.totalCount,
      numOfMembers: orgInfo.data.organization.membersWithRole.totalCount,
      mostPrs: orgMetrics.mostPr,
      averagePrs: Math.round(totalCount.pr / metrics.length),
      mostIssues: orgMetrics.mostIssues,
      averageIssues: Math.round(totalCount.issue / metrics.length),
    },
  ];

  const headers = [
    { id: "numOfMembers", title: "Number of Members" },
    { id: "numOfProjects", title: "Number of Projects" },
    { id: "numOfRepos", title: "Number of Repositories" },
    { id: "mostPrs", title: "Repo with Most Pull Requests" },
    { id: "averagePrs", title: "Average Pull Requests" },
    { id: "mostIssues", title: "Repo with Most Issues" },
    { id: "averageIssues", title: "Average Issues" },
  ];
  if (storeData) {
    spinner.start("Exporting...");
    await exportCSV.csvExporter(path, headers).writeRecords(storeData);
    spinner.succeed(`Exporting Completed: ${path}`);
  }
};
