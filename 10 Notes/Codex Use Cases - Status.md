
From the initial chat with Volo, we got two main use cases, which might actually be one use case:

* overcoming Waku message size limitations for long messages (why can't they just break those up and send multiple messages though?);
* implementing file sharing, with images (and I suppose audio?) being the main use case; i.e., that gives us a ballpark in content size;
* Jacek
### Requirements

**Codex has to run on mobile.** This might be a big deal as mobile networks are notoriously unsuitable to P2P software. Good news is that we got Waku and they seem to have worked around this, so we should start by examining their solution.

Whatever we come up with here has important value to the project as a whole though, as enabling Codex on mobile and having a workable solution in messy networks would take care of the single most recurrent complaint we have had from users so far.
### Unknowns

* It's clear that status will run a Codex client within the status app, which will require having lib-codex, but where will _storage_ actually happen? Are nodes expected to connect to each? Are we gonna have "storage" nodes operated by status? 
  
* How can whatever we come up with be abused/attacked? As we understand this, this will likely start giving us a glimpse of what are the characteristics for useful altruistic modes.

* Can we live up to the perf/latency standards of a chat app? 
### Meeting Transcripts

* [Initial Chat with Volo](https://docs.google.com/document/d/1UJROxEl7GCEAARhJRVOjYCWVyL2nhKeNvN77yMoJdas/edit?tab=t.8t9d24txz7de#heading=h.29nrust7c16y)