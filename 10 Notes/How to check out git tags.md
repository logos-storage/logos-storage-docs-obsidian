---
link: https://graphite.dev/guides/how-to-check-out-git-tags
---
```bash

# fetch tags
git fetch --tags

# list tags
git tag

# search
git tag -l <pattern>
```

## [Basic tag checkout](https://graphite.dev/guides/how-to-check-out-git-tags#basic-tag-checkout)

- **Git checkout tag**: To checkout a tag, use the `git checkout` command followed by the tag name:
    
    `git checkout <tag-name>`
    
    This command switches your working directory to the state of the specified tag.
    
- **Git checkout a tag as new branch**: If you want to make changes starting from a tag, it's best to checkout the tag into a new branch:
    
    `git checkout -b <new-branch-name> <tag-name>`
    

### [Working with remote tags](https://graphite.dev/guides/how-to-check-out-git-tags#working-with-remote-tags)

- **Git checkout tag from remote**: To checkout a tag that exists in the remote repository but not locally, first fetch the tags:
    
    `git fetch --tags`
    
    Then, checkout the tag using the `git checkout <tag-name>` command.
    
- **Git checkout remote tag as branch**: After fetching tags, you can create a new branch from a remote tag similarly to how you would with a local tag:
    
    `git checkout -b <branch-name> <tag-name>`

### [Advanced tag operations](https://graphite.dev/guides/how-to-check-out-git-tags#advanced-tag-operations)

- **Git checkout latest tag**: To checkout the most recent tag, first fetch the tags from remote:
    
    `git fetch --tags`
    
    Then find the latest tag with a combination of the `git describe` and `git rev-list` commands. You can save this tag to a local variable for use in the next step:
    
    `latestTag=$(git describe --tags $(git rev-list --tags --max-count=1))`
    
    Once you have the latest tag, check out as normal using the variable we just created:
    
    `git checkout $latestTag`
    
- **Git Checkout tagged Version/branch/commit**: These operations are fundamentally similar, as they involve checking out a specific state identified by a tag. Use the `git checkout <tag-name>` command for a version or commit, and if you want to start a new branch from a tagged commit, use `git checkout -b <new-branch-name> <tag-name>`.

### [Handling issues and special cases](https://graphite.dev/guides/how-to-check-out-git-tags#handling-issues-and-special-cases)

- **Git checkout tag without detached HEAD**: When you checkout a tag directly, Git puts your repository in a "detached HEAD" state. To avoid this, checkout the tag into a new branch:
    
    `git checkout -b <new-branch-name> <tag-name>`
    
    For further reading on this state, please see the guide on [resolving a detached HEAD state](https://graphite.dev/guides/how-to-resolve-detached-head-state-in-git).
    
- **Git checkout tag not working**: If you encounter issues checking out a tag, ensure the tag exists (`git tag`) and that you have fetched the latest tags from the remote repository (`git fetch --tags`).