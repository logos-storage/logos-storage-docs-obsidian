Let' take a look at the drawing below:

![[HackMD_GitHub_Obsidian-1.svg]]


GitHub is our source of truth. You connect to the team by cloning the repo on your machine. Think of it as a database. Of course you can use SQL queries to edit the database directly, but often you will use a more convenient system to input your data to the database. Obsidian is such a more convenient system. Now when you modify or add a document via Obsidian, these changes stay local (or private). To have them available to others, you need to commit your changes to the underlying git repository and push the changes to GitHub (usually via a separate PR).

Your local drive is not the only way things can end up in our documentation repository. The other valid way is [HackMd](https://hackmd.io/):

![[HackMD_GitHub_Obsidian-2.svg]]
*USER 1* and *USER 2*, can pull the content to HackMD, and push the changes back, without using Obsidian at all (we will see later why we do recommend to still use Obsidian even when using in HackMD). Also, the user may be tempted to just use HackMd, without using either GitHub or Obsidian and just make sure that just add the content to the *Codex Storage* workspace on HackMd - *also not recommended*.

![[CodexDocumentationSetup-20250807072740.png]]

Thus, to keep things manageable, we distinguish two workflows:

1. [[GitHub-Obsidian Workflow]]
2. [[HackMD-GitHub-Obsidian Workflow]]

[[GitHub-Obsidian Workflow]] is the default workflow when you do not have to extensively collaborate on the document or if the comments on the created PR are sufficient to effectively communicate and decide on the final content. The [[HackMD-GitHub-Obsidian Workflow]] is more complex, and thus should only be used when the document is a collaborative effort and you expect lots comments and iteration before converging to something more stable.

Above, we mention that using HackMD alone is not recommend. Why? The reason is very simple. When the number of documents is low, and they are not interconnected, it is indeed tempting to make one's live easier and just keep lots of documents in HackMD. What if HackMD becomes unavailable? Or if we decide to use a different tool to collaborate on the content. Moving lots of files from HackMD will be a pain. Finally, it requires much more discipline and manual effort to keep the documents organised on HackMD via folders, bookmarks, and tags. Thus, please only use the two workflows listed above. 