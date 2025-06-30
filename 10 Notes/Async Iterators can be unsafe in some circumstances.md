---
related-to:
  - "[[AsyncIter]]"
  - "[[AsyncResultIter]]"
  - "[[Async Iterators]]"
---
Basically, when using async iterators (`AsyncIter`, `AsyncResultIter`), please stay away from `toSeq(iter)` where `iter` is an instance of unfinished async iterator.

It will basically end-up in an endless loop and will eat all your computers memory...

This is because `toSeq` under the hood will just use `items` but without awaiting on the returned future. Here is how `items` is defined:

```nim
iterator items*[T](self: AsyncResultIter[T]): auto {.inline.} =
  while not self.finished:
    yield self.next()
```

There is no way in current Nim to create a truly async `iterator`. In the code above, the while loop will not finish till `self.finished` evaluates to `true`. But this can never happen if the caller of the `items` iterator never awaits on the returned value (which will be a `Future` in the case of any of our async iterators). Only when awaiting, `next` will update the iterator state and potentially set `finished` member to `true`:

```nim
proc next(): Future[?!T] {.async: (raises: [CancelledError]).} =
	try:
	  if not iter.finished:
		let item = await genNext()
		if finishOnErr and err =? item.errorOption:
		  iter.finished = true
		  return failure(err)
		if isFinished():
		  iter.finished = true
		return item
	  else:
		return failure("AsyncResultIter is finished but next item was requested")
	except CancelledError as err:
	  iter.finished = true
	  raise err
```
