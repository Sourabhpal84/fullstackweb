export default function Loading() {
  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="skeleton h-16 rounded-2xl" />
        <div className="skeleton h-[420px] rounded-[32px]" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div className="skeleton h-48 rounded-3xl" key={index} />
          ))}
        </div>
      </div>
    </main>
  );
}
