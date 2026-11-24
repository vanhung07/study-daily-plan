# StudyPlan — Lập kế hoạch học tập hằng ngày

Ứng dụng web tối giản giúp học sinh, sinh viên và người tự học lên lịch học theo khung giờ, theo dõi tiến độ và giữ sự tập trung. Không cần cài đặt, không cần máy chủ — dữ liệu được lưu ngay trên trình duyệt của bạn.

## Tính năng chính

- **Lịch theo khung giờ (05:00 – 24:00):** kéo trên vùng trống để tạo khung giờ, kéo khung để dời, kéo mép dưới để đổi thời lượng (bước 15 phút). Các khung giờ trùng nhau tự động xếp thành nhiều cột.
- **Quản lý môn học:** mỗi môn có một màu pastel riêng; lọc lịch theo môn chỉ với một cú nhấp.
- **Việc nhỏ (sub-task):** chia khung giờ thành danh sách việc cần làm và tick hoàn thành.
- **Bộ đếm tập trung:** chế độ Pomodoro 25/5 hoặc đếm theo độ dài khung giờ. Đồng hồ dựa trên mốc thời gian nên vẫn chính xác khi bạn đổi ngày, đổi tab hoặc tải lại trang; thời gian đã học được tự động cộng vào khung giờ.
- **Tổng quan trong ngày:** mục tiêu quan trọng nhất, phần trăm hoàn thành, thời gian đã lên lịch / thực học và chuỗi ngày học liên tiếp.
- **Lịch nhỏ:** xem nhanh những ngày đã có kế hoạch.
- **Tiện ích:** chép lịch từ hôm qua, chuyển khung giờ sang ngày mai, hoàn tác khi xoá hoặc dời, giao diện Sáng/Tối, dùng tốt trên điện thoại.

## Cách chạy

**Cách 1 — đơn giản nhất:** nhấp đúp vào tệp `index.html` để mở bằng trình duyệt.

**Cách 2 — chạy máy chủ cục bộ:**

```bash
python -m http.server 8000
```

Sau đó mở <http://localhost:8000>.

## Cấu trúc thư mục

```text
daily-plan/
├── index.html          # Khung giao diện (HTML)
├── css/
│   ├── tokens.css      # Biến thiết kế: màu, khoảng cách (Sáng/Tối)
│   └── styles.css      # Kiểu dáng các thành phần
├── js/
│   ├── utils.js            # Hàm tiện ích: ngày giờ, định dạng, escape HTML
│   ├── store.js            # Dữ liệu, lưu localStorage, thống kê, nhập/xuất JSON
│   ├── timer.js            # Bộ đếm tập trung dựa trên mốc thời gian
│   ├── timeline.js         # Lưới giờ, bố cục khung trùng nhau, kéo thả
│   ├── firebase-config.js  # Cấu hình Firebase cho đồng bộ đám mây
│   ├── sync.js             # Đồng bộ thời gian thực qua Firebase Auth + Firestore
│   ├── ui.js               # Thanh bên, hộp thoại, thông báo, phím tắt
│   └── app.js              # Khởi động ứng dụng
└── README.md
```

## Đồng bộ đám mây giữa điện thoại & máy tính (Firebase)

Ứng dụng hỗ trợ đồng bộ thời gian thực miễn phí qua **Firebase Authentication (Google)** và **Cloud Firestore**:

1. Tạo dự án miễn phí tại [Firebase Console](https://console.firebase.google.com/).
2. Vào **Authentication → Sign-in method** và bật **Google**. Trong **Authentication → Settings → Authorized domains**, thêm tên miền web của bạn (ví dụ `vanhung07.github.io`).
3. Vào **Firestore Database → Create database** (Production mode) và thiết lập **Rules** như sau để mỗi người dùng chỉ truy cập được dữ liệu của chính mình:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /studyPlans/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

4. Vào **Project Settings → Your apps → Web (`</>`)** để lấy `firebaseConfig`, sau đó điền vào tệp `js/firebase-config.js` (và đẩy lên GitHub để tự áp dụng cho mọi thiết bị), hoặc dán trực tiếp trong nút **Đồng bộ đám mây (Cài đặt)** trên giao diện web.

## Sao lưu và khôi phục (JSON)

- **Xuất JSON:** nhấn **Xuất JSON** ở cuối thanh bên để tải tệp `daily-study-plan-YYYY-MM-DD.json`.
- **Nhập JSON:** nhấn **Nhập JSON**, chọn tệp, rồi chọn:
  - **Gộp vào dữ liệu hiện tại** — giữ dữ liệu đang có và thêm dữ liệu từ tệp.
  - **Ghi đè toàn bộ** — thay thế hoàn toàn bằng dữ liệu trong tệp.

> Dữ liệu chỉ nằm trong trình duyệt hiện tại. Hãy xuất JSON định kỳ, nhất là trước khi xoá dữ liệu duyệt web hoặc đổi máy.

## Phím tắt

| Phím | Chức năng |
| --- | --- |
| `N` | Thêm khung giờ mới |
| `T` | Về hôm nay |
| `←` / `→` | Ngày trước / ngày sau |
| `Esc` | Đóng hộp thoại hoặc thanh bên |
| `Enter` (trong ô việc nhỏ) | Thêm việc nhỏ |

Các phím `N`, `T`, `←`, `→` không hoạt động khi bạn đang gõ trong ô nhập hoặc khi một hộp thoại đang mở.
