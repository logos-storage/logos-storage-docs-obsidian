We know Nim is garbage collected. Yet, this tells us very little as to what the _actual_ memory usage of a Nim application is going to be. In fact, as I made modifications to the core Codex block protocol, I have seen often surprising usage patterns not caused by memory leaks, but by how refc seems to manage memory and schedule its collection cycles.

This document puts together my understanding of refc as I explore it, hoping that it will be of use for future reference.

## When is refc triggered?

The first point to understand is _when_ does refc gets triggered. This has direct impact in memory usage: if it gets triggered very infrequently but we are allocating large chunks of memory, your peak memory usage will be much higher than if, say, it runs immediately after every object becomes eligible for garbage collection. Since the former would lead to unnacceptable memory usage while the latter to unnacceptable GC overhead, we expect `refc` to sit somewhere in the middle.

By looking at [refc's source code](), we can see that the entry point for proc for a refc run is:

```nim=
proc collectCT(gch: var GcHeap) =
  if (gch.zct.len >= gch.zctThreshold or (cycleGC and
      getOccupiedMem(gch.region)>=gch.cycleThreshold) or alwaysGC) and
      gch.recGcLock == 0:
    when false:
      prepareForInteriorPointerChecking(gch.region)
      cellsetReset(gch.marked)
      markForDebug(gch)
    collectCTBody(gch)
    gch.zctThreshold = max(InitialZctThreshold, gch.zct.len * CycleIncrease)
```
**Listing 1.** refc's entry point proc.

This is only called by internal Nim code - you cannot call it as an app developer. By further scanning the codebase, we can see that `collectCT` gets called in four places: 

* `GC_fullCollect`. This is a public (API) proc that can be called by the developers to trigger a GC run manually;
* `rawNewObj`/`rawNewObjRC1`. Those are called by `newObj`, `newObjRC1`, and `newObjNoInit`, which are in turn inserted by the compiler when someone creates a heap-allocated object like a `ref` object or a sequence;
* `growObj`. Called by `incrSeq/incrSeq{V2,V3}`, which are called from compiler-generated code when elements are appended to a sequence (e.g., as a result of calling `add`).

With the exception of `GC_fullCollect`, all of the others GC triggers are _allocation_ operations. Note, however, that the GC will not necessarily run at every single allocation, it merely gets an opportunity to do so if certain conditions are met. We are going to look at what these conditions look like next.


## Deferred Reference Counting

The first condition in line $2$ of Listing 1 says `gch.zct.len >= gch.zctThreshold`. What does that mean?

refc is based on some ideas drawn from Deutch and Bobrow's LISP garbage collector[^1], the main of which is the use of a deferred reference counting. The key insight is that the majority of the references to a heap-allocated object will be coming from the stack. These references appear and disappear as the object is passed around and assigned to local variables and arguments, and keeping count of them explicitly leads to overhead.

Stack references are, therefore, _not eagerly counted_, which means only references from other heap-allocated objects (and, presumably, globally-scoped references) are. But if not all references are counted, how does the garbage collector knows when to collect an object?

Well, stack references are counted, but in a _deferred_ fashion. The GC keeps an internal "table" with all the heap-allocated objects for which there are zero references - the Zero Count Table or ZCT. Whenever the GC is triggered, it first:

1. scans the stack for active pointers to reference-counted, heap-allocated objects and increase their reference count (deferred counting);
2. sweeps through the ZCT and garbage collects all the objects for which the reference count remains zero, as well as the objects they are pointing to;
3. scans the stack for a second time, but this time decreasing the reference count to heap-allocated objects; i.e., it restores the counters so that the deferred counting works properly during the next cycle.

Step one is done in `markStackAndRegisters`:

```nim=
proc markStackAndRegisters(gch: var GcHeap) {.noinline, cdecl,
    codegenDecl: "CLANG_NO_SANITIZE_ADDRESS N_LIB_PRIVATE $# $#$#".} =
  forEachStackSlot(gch, gcMark)

proc gcMark(gch: var GcHeap, p: pointer) {.inline.} =
  # the addresses are not as cells on the stack, so turn them to cells:
  sysAssert(allocInv(gch.region), "gcMark begin")
  var c = cast[int](p)
  if c >% PageSize:
    # fast check: does it look like a cell?
    var objStart = cast[PCell](interiorAllocatedPtr(gch.region, p))
    if objStart != nil:
      # mark the cell:
      incRef(objStart)
      add(gch.decStack, objStart)
    when false:
      let cell = usrToCell(p)
      if isAllocatedPtr(gch.region, cell):
        sysAssert false, "allocated pointer but not interior?"
        # mark the cell:
        incRef(cell)
        add(gch.decStack, cell)
  sysAssert(allocInv(gch.region), "gcMark end")
``` 
 
Now that we understand this, we can look at the condition in Listing 1 again with fresh eyes: 

```nim=
if gch.zct.len >= gch.zctThreshold ...:
```

we call this the _ZCT overuse_ condition, and it tells us that the garbage collector will run when the ZCT grows past a certain size, the `zctThreshold`; i.e., if the ZCT grows too large, we will attempt to garbage collect. 

This of course has a side effect: since the counts in the ZCT are deferred, it might be that a collection does not actually free anything, and we end the collection cycle with a ZCT that is as large as when we began. This will lead the GC to run again during the next allocation (as the ZCT overuse condition is still met), and potentially again, and again, and again, leading to GC thrashing.

This has indeed [been an issue in refc's past](https://github.com/nim-lang/Nim/issues/10040), and is the reason why `collectCT` will try to resize the ZCT after every collection cycle to twice its occupancy rate; i.e., to a load factor of $0.5$:

```nim=
gch.zctThreshold = max(InitialZctThreshold, gch.zct.len * CycleIncrease)
```
 
This of course begs the question: how will this ensure bounded memory usage at all? If we are counting objects in the ZCT, a Nim program's memory usage will be given by $\text{ZCT capacity} \times \text{average object size}$. If your average object size is large - say, $1\text{GB}$, the default ZCT threshold would seem to imply that the bound on memory usage would be around $500\text{GB}$.

Fortunately, refc has that covered.

## Memory Pressure Triggers

The second GC trigger is in the somewhat cryptic:

```nim=
getOccupiedMem(gch.region) >= gch.cycleThreshold
```

`cycleThreshold` actually has nothing to do with cycles - it is the total memory that the GC will allow to be occupied by heap-allocated objects before it attempts to garbage collect. We call this the _memory overuse_ condition.

The reason this is called `cycleThreshold` is because, unlike what happens with ZCT overuse, the GC will also attempt to reclaim cycles when the memory overuse condition is met.

Finally, as we can see in `collecCTBody`, `cycleThreshold` will also be dynamically resized to a load factor of $0.5$ after every cycle collection to avoid thrashing:

```nim=
gch.stat.maxThreshold = max(gch.stat.maxThreshold, gch.cycleThreshold)
```

## Implications

One of the immediate implications is that your application may clock twice as much memory as its real peak memory usage. If you allocate fewer larger objects, then you will breach the memory overuse condition and refc will leave room for twice your requirements so that the GC does not need to run that often.

[^1]: https://dl.acm.org/doi/abs/10.1145/360336.360345