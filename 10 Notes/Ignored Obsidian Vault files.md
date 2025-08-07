Not everything from the vault should go to the repository. For instance: your workspace settings should stay private as they change every time you open a new file. Similarly, you `10 Notes/Inbox` file - which is similar to a scratch buffer - should stay private as well. Also, currently, the calendar entries that are stored in the `00 Planner/` folder are currently considered private.

If you need to have some specific file ignored, you may decide to add your own entry to `.github` in a section that starts with a comment, e.g.


```
# John Doe ignore list
```

or something similar. Try to be specific and consider placing the content you need to have ignored under the `10 Notes` folder temporarily, e.g. `10 Notes/JhonDoe` and then ignore that whole folder in `.gitignore`. It is wise to consider keeping your private stuff in a private vault and keep the Codex vault more suitable for the team content.
