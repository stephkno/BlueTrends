
export {
    MinHeap,
    findTopN
};

class MinHeap {
    constructor() {
        this.heap = [];
    }

    push(val) {
        this.heap.push(val);
        this._heapifyUp();
    }

    pop() {
        if (this.heap.length === 0) return null;
        const min = this.heap[0];
        const last = this.heap.pop();

        if (this.heap.length > 0) {
            this.heap[0] = last;
            this._heapifyDown();
        }
        return min;
    }

    _heapifyUp() {
        let index = this.heap.length - 1;

        while (index > 0) {
            const parentIndex = Math.floor((index - 1) / 2);

            // compare node values
            if (this.heap[index][1].likes >= this.heap[parentIndex][1].likes) break;
            [this.heap[index], this.heap[parentIndex]] = [this.heap[parentIndex], this.heap[index]];
            index = parentIndex;
        }
    }

    _heapifyDown() {
        let index = 0;
        while (index < this.heap.length) {
            const leftChildIndex = 2 * index + 1;
            const rightChildIndex = 2 * index + 2;
            let smallest = index;

            // compare node values
            if (leftChildIndex < this.heap.length && this.heap[leftChildIndex][1].likes < this.heap[smallest][1].likes) {
                smallest = leftChildIndex;
            }
            if (rightChildIndex < this.heap.length && this.heap[rightChildIndex][1].likes < this.heap[smallest][1].likes) {
                smallest = rightChildIndex;
            }
            if (smallest === index) break;

            [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
            index = smallest;
        }
    }
}

function findTopN(n, array) {
    const minHeap = new MinHeap();

    // Iterate over the array
    for (let item of array) {
        if (minHeap.heap.length < n) {
            minHeap.push(item);
        } else if (item > minHeap.heap[0]) {
            minHeap.pop();
            minHeap.push(item);
        }
    }

    // Pop the items from the heap to get the top 25
    const top = [];
    while (minHeap.heap.length > 0) {
        top.push(minHeap.pop());
    }

    // Sort the top 25 in descending order (optional)
    return top.reverse();
}
