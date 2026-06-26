export function readModelBlock(schema: string, modelName: string): string {
  const modelStart = schema.indexOf(`model ${modelName} {`);
  const modelEnd = schema.indexOf("\n}", modelStart);

  if (modelStart === -1 || modelEnd === -1) {
    throw new Error(`model block missing for ${modelName}`);
  }

  return schema.slice(modelStart, modelEnd + 2);
}
