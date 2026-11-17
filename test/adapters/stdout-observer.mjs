const write = process.stdout.write.bind(process.stdout);
process.stdout.write = function (...args) {
  const accepted = write(...args);
  process.stderr.write(
    JSON.stringify({
      stdout_write: true,
      accepted,
      buffered: process.stdout.writableLength,
    }) + "\n",
  );
  return accepted;
};
