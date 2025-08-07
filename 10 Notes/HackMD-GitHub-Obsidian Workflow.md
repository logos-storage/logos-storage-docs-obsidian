This workflow is slightly more complex. Not only because you need to pull/push content from/to GitHub, but because it is easy to create a mess.

The workflow is the following:

1. Author the document in Obsidian.
2. Create a branch and a (draft) PR.
3. Pull the content in HackMd in the *Codex Storage* workspace.
   *Consider using a separate folder named after your branch.*
4. Invite collaborators.
5. Collaborate, comment, and modify the document content. Take special care for images and similar media files that you want to embed in the document (links are *ok* sparingly, but it is always better to have a local copy kept on GitHub). If you do it via HackMd, you need to take care later that this content is copied to GitHub and properly linked in Obsidian (in Obsidian all the assets are kept in the `90 Extras/92 Assets` directory - this is where your non-markdown media files need to end up). If you do not need to collaborate on the media content or when you can just share them via some other channel, it is usually easier to add this content via Obsidian and then pull the changes to HackMD (although the media will not render in HackMD in such a case, unless you use direct links to that content on GitHub - temporarily fine, but not recommended in the final document). Obsidian is very convenient to work with media content in your markdown, so please take advantage of it.
6. After you reach consensus, push the final version of the document to your PR branch.
7. Check the content in Obsidian.
8. Get the PR approval(s).
9. Merge `main`.
10. Consider deleting the merged content and the "branch" folder from HackMD.
    _HackMD does not seem to have any convenient way to export comments, so if you need to preserve the conversation, I would consider creating a separate document and copy the conversation or its summary there. Keeping the document hanging in HackMD sooner or later will result in a mass. Let's build a good habit: **all documents in GitHub**._

Consider checking our [[Using Codex Obsidian Vault Video Tutorials]]. There is one about using HackMD, GitHub, and Obsidian together.
