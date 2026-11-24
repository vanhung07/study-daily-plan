# Project Context: Study Plan Web Application

## 1. Tổng quan dự án (Project Overview)
Đây là ứng dụng web **Study Plan** giúp học sinh, sinh viên và người tự học lên lịch trình học tập, quản lý mục tiêu môn học, theo dõi tiến độ hoàn thành và tối ưu hóa thời gian tập trung.
- **Mục tiêu cốt lõi:** Giao diện tối giản (Minimalist), giảm xao nhãng, trực quan hóa tiến độ học tập theo ngày/tuần/tháng.
- **Đối tượng người dùng:** Học sinh, sinh viên, người học ngoại ngữ hoặc ôn thi chứng chỉ.

## 2. Công nghệ sử dụng (Tech Stack)
*(Lưu ý: Điều chỉnh lại phần này nếu bạn dùng stack khác)*
- **Frontend Framework:** React / Next.js (App Router) với TypeScript
- **Styling & UI:** Tailwind CSS, Lucide React (icons), Shadcn/UI (hoặc Radix UI)
- **State Management & Data Fetching:** Zustand, TanStack Query (React Query)
- **Database & Auth:** Supabase / Firebase (hoặc LocalStorage cho phiên bản MVP)
- **Thư viện bổ trợ:** `date-fns` (xử lý ngày giờ), `recharts` (biểu đồ thống kê tiến độ), `@dnd-kit` (kéo thả lịch học).

## 3. Các tính năng chính (Core Features)
1. **Dashboard tổng quan:** Hiển thị tiến độ học tập trong ngày, chuỗi ngày học liên tiếp (Study Streak), và danh sách nhiệm vụ ưu tiên.
2. **Lịch học tương tác (Study Schedule / Calendar):** Xem và kéo thả các khung giờ học (Time-blocking) theo ngày hoặc tuần.
3. **Quản lý môn học & Mục tiêu (Subjects & Milestones):** Phân loại công việc theo từng môn học với mã màu riêng (Color-coding), chia nhỏ mục tiêu lớn thành các task nhỏ.
4. **Bộ đếm tập trung (Pomodoro Timer):** Tích hợp đồng hồ đếm ngược (25 phút học / 5 phút nghỉ) gắn liền với từng task cụ thể và tự động lưu thời gian đã học.
5. **Thống kê & Báo cáo (Analytics):** Biểu đồ phân bổ thời gian học theo từng môn trong tuần/tháng.

## 4. Cấu trúc thư mục (Directory Structure)
- `/src/app` (hoặc `/src/pages`): Các trang chính (`/dashboard`, `/calendar`, `/subjects`, `/analytics`).
- `/src/components/ui`: Các component giao diện cơ bản (Button, Card, Modal, Input).
- `/src/components/features`: Các component nghiệp vụ đặc thù (`PomodoroTimer`, `WeeklyCalendar`, `TaskBoard`, `StreakBadge`).
- `/src/hooks`: Custom hooks (`useTimer`, `useStudyStats`, `useTasks`).
- `/src/stores`: Quản lý state toàn cục (trạng thái đồng hồ Pomodoro đang chạy, bộ lọc môn học).
- `/src/types`: Định nghĩa TypeScript interfaces (`Task`, `Subject`, `StudySession`, `Goal`).
- `/src/utils`: Các hàm xử lý thời gian, tính toán phần trăm hoàn thành.

## 5. Quy chuẩn UI/UX (Design Guidelines)
- **Phong cách:** Sạch sẽ, hiện đại, ưu tiên không gian trắng (whitespace) để người học không bị ngợp thông tin.
- **Màu sắc:** Hỗ trợ chế độ Sáng/Tối (Light/Dark mode). Mỗi môn học có một màu pastel nhẹ nhàng để dễ phân biệt trên lịch.
- **Responsive:** Hoạt động mượt mà trên cả máy tính (để lập kế hoạch chi tiết) và điện thoại (để xem nhanh lịch học và bấm giờ Pomodoro).

## 6. Quy tắc lập trình (Coding Conventions)
- **Ngôn ngữ:** Viết code, tên biến, tên hàm và comment trong code bằng **tiếng Anh**. Giao tiếp và giải thích với người dùng bằng **tiếng Việt**.
- **TypeScript:** Bắt buộc khai báo kiểu dữ liệu chặt chẽ, tuyệt đối không dùng `any`.
- **Xử lý ngày giờ:** Luôn dùng thư viện `date-fns` để xử lý múi giờ và định dạng ngày tháng nhất quán, tránh dùng `new Date()` thao tác thủ công dễ gây lệch múi giờ.
- **Tách biệt Logic:** Tách logic đếm ngược của Pomodoro hoặc tính toán lịch trình ra khỏi UI component bằng Custom Hooks.
- **Trạng thái rỗng (Empty States):** Luôn thiết kế giao diện thân thiện kèm nút kêu gọi hành động (CTA) khi người dùng chưa tạo môn học hoặc chưa có lịch học nào.

## 7. Các lệnh thường dùng (Commands)
- Khởi chạy môi trường phát triển: `npm run dev`
- Kiểm tra kiểu dữ liệu TypeScript: `npm run type-check`
- Kiểm tra quy chuẩn code: `npm run lint`
- Build sản phẩm: `npm run build`

## 8. Ràng buộc quan trọng (Constraints)
- Đồng hồ Pomodoro phải tiếp tục đếm chính xác ngay cả khi người dùng chuyển đổi giữa các tab/trang trong ứng dụng (lưu timestamp bắt đầu thay vì chỉ dùng `setInterval` thuần túy).
- Mọi thao tác thêm, sửa, xóa lịch học phải có phản hồi tức thì (Optimistic UI) và thông báo trạng thái rõ ràng.