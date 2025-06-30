---
related-to:
  - "[[Codex Encryption Basis]]"
  - "[[How to get a pointer to a seq to pass it to a C library]]"
---
As summarized in [[Codex Encryption Basis#^b2e265|the proposal]], we:

- use a freshly generated random master key (at least 256 bits) per dataset (generated and kept on the user's machine)
- derive a new encryption key and also an IV for each block from the master key and the block index
- use for example AES192-CBC

For example, we could have

    key = SHA256( MASTER_KEY || block_index ), truncated to 192 bits
    IV  = SHA256( MASTER_IV  || block_index ), truncated to 128 bits
    
where both `MASTER_KEY` and `MASTER_IV` are 256 bit random numbers, and `||` denotes concatenation.

If storing 512 bits (as opposed to a 256 bit minimum) of key material is a problem, we could derive both by the same key, for example as

    key' = SHA256( MASTER_KEY || 0x01 || block_index ), truncated to 192 bits
    IV'  = SHA256( MASTER_KEY || 0x02 || block_index ), truncated to 128 bits


Some context info:

- [bearssl](https://bearssl.org/)
- [bearssl Nim bindings](https://github.com/status-im/nim-bearssl)