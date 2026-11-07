export const TARGETS = {
  claude:  { label: 'Claude',  format: 'claude-xml', budget: 200000 },
  chatgpt: { label: 'ChatGPT', format: 'markdown',   budget: 128000 },
  gemini:  { label: 'Gemini',  format: 'markdown',   budget: 1000000 },
  custom:  { label: 'Custom' }
};

export function detectTarget(format, budget) {
  const numBudget = Number(budget);
  for (const [key, target] of Object.entries(TARGETS)) {
    if (target.format && target.budget !== undefined) {
      if (target.format === format && target.budget === numBudget) {
        return key;
      }
    }
  }
  return 'custom';
}
