# @wappajs/anthropic

Anthropic (Claude) provider for [wappa](https://github.com/sifenfisaha/wappajs) WhatsApp
agents. Maps one wappa `generate()` call onto the Anthropic Messages API, including
tool-calling.

```bash
npm install @wappajs/core @wappajs/anthropic
```

```ts
import { Agent } from '@wappajs/core';
import { AnthropicProvider } from '@wappajs/anthropic';

const agent = new Agent({
  instructions: 'You are a helpful WhatsApp assistant.',
  provider: new AnthropicProvider(), // reads ANTHROPIC_API_KEY from the environment
});
```

Pick a model or pass your own client:

```ts
new AnthropicProvider({ model: 'claude-sonnet-5', apiKey: '...', effort: 'medium' });
```

The default model is `claude-sonnet-5`. The agent's `knowledge` is cached at the API
with a cache breakpoint, and the thinking blocks of a tool-calling turn are kept on the
session and replayed unchanged, as the current models require. `AnthropicClientLike`
lets you inject a stub in tests, and the mapping helpers are exported if you need to
inspect what gets sent.

Docs: https://github.com/sifenfisaha/wappajs/blob/main/docs/providers.md

## License

MIT
