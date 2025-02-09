import rocksdb from 'rocksdb'

// Open a RocksDB instance
const db = rocksdb('./mydb');

// Open the database
db.open(err => {
  if (err) {
    console.error("Error opening the database", err);
    return;
  }

  console.log("Database opened!");

  // Insert some sorted data
  db.put('10', 'item1', (err) => {
    if (err) {
      console.error("Error inserting item1", err);
    }
  });
  db.put('1', 'item2', (err) => {
    if (err) {
      console.error("Error inserting item2", err);
    }
  });
  db.put('15', 'item3', (err) => {
    if (err) {
      console.error("Error inserting item3", err);
    }
  });

  // Create an iterator to traverse the sorted data
  const iter = db.iterator();

  // Start iteration from the first key 'item1'
  iter.seek('1');

  // Start iteration manually
  iter.next((err, key, value) => {
    if (err) {
      console.error("Error iterating", err);
      return;
    }

    // If there's no key, the iterator has finished
    if (!key) {
      console.log("Iteration finished.");
      iter.end(() => {
        console.log("Iterator closed.");
      });
      return;
    }

    // Print the key and value
    console.log(`Key: ${key}, Value: ${value}`);

    // Continue iterating
    iter.next((err, key, value) => {
      if (err) {
        console.error("Error iterating", err);
        return;
      }

      // If there's no key, the iterator has finished
      if (!key) {
        console.log("Iteration finished.");
        iter.end(() => {
          console.log("Iterator closed.");
        });
        return;
      }

      // Print the key and value
      console.log(`Key: ${key}, Value: ${value}`);

      // Continue iterating
      iter.next((err, key, value) => {
        if (err) {
          console.error("Error iterating", err);
          return;
        }

        // If there's no key, the iterator has finished
        if (!key) {
          console.log("Iteration finished.");
          iter.end(() => {
            console.log("Iterator closed.");
          });
          return;
        }

        // Print the key and value
        console.log(`Key: ${key}, Value: ${value}`);
        iter.end(() => {
          console.log("Iterator closed.");
        });
      });
    });
  });
});
