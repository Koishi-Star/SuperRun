import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";

export async function promptHiddenInput(options: {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  prompt: string;
}): Promise<string> {
  let muted = false;
  const mutedOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) {
        options.output.write(chunk, encoding as BufferEncoding, callback);
        return;
      }

      callback();
    },
  });

  const readline = createInterface({
    input: options.input,
    output: mutedOutput,
    terminal: true,
  });

  const onSigint = () => {
    readline.close();
  };
  readline.on("SIGINT", onSigint);

  try {
    options.output.write(options.prompt);
    muted = true;
    const value = await readline.question("");
    options.output.write("\n");
    return value.trim();
  } finally {
    readline.off("SIGINT", onSigint);
    readline.close();
  }
}
